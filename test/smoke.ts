/**
 * Smoke test for the extension plumbing, without booting Pi.
 *
 *   npm test
 *
 * Builds a fake ExtensionAPI + ExtensionContext, captures what the extension
 * registers, and drives the gate through the cases that matter.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeTurnEnd } from "../src/detect.ts";
import momentumExtension from "../src/index.ts";
import { RULE_PROMPT } from "../src/virtual.ts";
import { loadConfig } from "../src/config.ts";

// Never read or write the real config: rules are resolved from the working
// directory and from $HOME.
const ROOT = mkdtempSync(join(tmpdir(), "pi-momentum-smoke-"));
process.env.HOME = join(ROOT, "home");
const PROJECT = join(ROOT, "project");
mkdirSync(join(PROJECT, ".pi"), { recursive: true });

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	commands: Map<string, Handler>;
	sent: string[];
	entries: Array<{ type: string; data: unknown }>;
	notifications: string[];
	statuses: Array<string | undefined>;
	completeCalls: number;
	selects: number;
	selectOptions: string[];
	selectPick?: string;
	/** Suggestions the autocomplete provider returns for a given editor line. */
	suggestions: (line: string) => Promise<{ prefix: string; items: Array<{ value: string }> } | null>;
	ctx: never;
}

interface HarnessOptions {
	/** Raw text the virtual-user model call returns. */
	modelReply?: string;
	/** Assistant text on the session branch. */
	lastAssistant?: string;
	/** Reply used when the call is rule normalisation rather than a decision. */
	ruleReply?: string;
}

const CONTINUE_JSON = '{"action":"continue","reply":"继续","reason":"它在等确认"}';
const STOP_JSON = '{"action":"stop","reply":"","reason":"已经宣布完成"}';

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	const sent: string[] = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const counters = { completeCalls: 0, selects: 0 };
	const selectOptions: string[] = [];
	const selectState: { pick?: string } = {};
	const autocomplete: Array<(current: unknown) => unknown> = [];

	const current = {
		getSuggestions: async () => null,
		applyCompletion: (lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 }),
		shouldTriggerFileCompletion: () => true,
	};

	const ctx = {
		cwd: PROJECT,
		model: { id: "fake-model", provider: "fake" },
		modelRegistry: {
			find: () => undefined,
			complete: async (_model: unknown, context: { systemPrompt?: string }) => {
				counters.completeCalls += 1;
				const isRule = context?.systemPrompt === RULE_PROMPT;
				return {
					content: [{ type: "text", text: (isRule ? options.ruleReply : options.modelReply) ?? CONTINUE_JSON }],
					stopReason: "stop",
				};
			},
		},
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: options.lastAssistant ?? "" }] },
				},
			],
		},
		isIdle: () => true,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			select: async (_title: string, options: string[]) => {
				counters.selects += 1;
				selectOptions.push(...options);
				const pick = selectState.pick;
				return pick ? options.find((option) => option.includes(pick)) : undefined;
			},
			addAutocompleteProvider: (factory: (current: unknown) => unknown) => autocomplete.push(factory),
		},
	};

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, options_: { handler: Handler }) => commands.set(name, options_.handler),
		registerFlag: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendUserMessage: (content: string) => sent.push(content),
	};

	await momentumExtension(pi as never);

	// The provider is registered by the session_start handler, so it must be
	// resolved at call time, not at construction time.
	const resolveProvider = () =>
		autocomplete[0]?.(current) as
			| {
					getSuggestions: (
						lines: string[],
						cursorLine: number,
						cursorCol: number,
						options: unknown,
					) => Promise<{ prefix: string; items: Array<{ value: string }> } | null>;
			  }
			| undefined;

	return {
		handlers,
		commands,
		sent,
		entries,
		notifications,
		statuses,
		get completeCalls() {
			return counters.completeCalls;
		},
		get selects() {
			return counters.selects;
		},
		selectOptions,
		/** What the fake picker returns: undefined cancels. */
		set selectPick(pick: string | undefined) {
			selectState.pick = pick;
		},
		suggestions: (line: string) => {
			const provider = resolveProvider();
			return provider
				? provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal })
				: Promise.resolve(null);
		},
		ctx: ctx as never,
	} as Harness;
}

function settledEvent(): unknown {
	return { type: "agent_settled", aborted: false };
}

interface Case {
	name: string;
	/** Command to run first, e.g. "on". Empty means leave the default (off). */
	command?: string;
	text: string;
	modelReply?: string;
	expect: {
		/** A user message was injected. */
		sent?: string;
		/** Model calls made. */
		calls?: number;
		/** A decision entry with sent=true exists. */
		audited?: boolean;
		/** Any decision entry exists. */
		logged?: boolean;
		/** notification substring */
		notified?: string;
	};
	/** Present means: run `test` with this argument ("" = no argument). */
	probe?: string;
}

const CASES: Case[] = [
	{
		name: "off: a stop does nothing",
		text: "要我接着做这个吗？",
		expect: { sent: undefined, calls: 0, logged: false },
	},
	{
		name: "on: the reply is written as the user",
		command: "on",
		text: "下一步我建议先把 op50 的读取地址补上。要我继续吗？",
		expect: { sent: "继续", calls: 1, audited: true },
	},
	{
		name: "on: model says stop, nothing is sent but it is logged",
		command: "on",
		text: "190 测试绿，工作区干净。",
		modelReply: STOP_JSON,
		expect: { sent: undefined, calls: 1, logged: true, audited: false },
	},
	{
		name: "on: reply touching the never-list is dropped",
		command: "on",
		text: "需要我装一下 Ghidra 吗？",
		modelReply: '{"action":"continue","reply":"装一下新软件","reason":"它在问"}',
		expect: { sent: undefined, calls: 1, audited: false },
	},
	{
		name: "on: DONE skips the model call entirely",
		command: "on",
		text: "✓ DONE\n190 测试绿。",
		expect: { sent: undefined, calls: 0, logged: false },
	},
	{
		name: "on: BLOCKED skips the model call entirely",
		command: "on",
		text: "⏸ BLOCKED\n要不要清掉 470MB 中间产物",
		expect: { sent: undefined, calls: 0, logged: false },
	},
	{
		name: "on: the cap hands control back",
		command: "on",
		text: "要我接着做这个吗？",
		expect: { sent: "继续", calls: 1 },
	},
	{
		name: "test with no argument reads the last assistant message",
		text: "要我接着做这个吗？",
		probe: "",
		expect: { sent: undefined, calls: 1, notified: "last assistant message" },
	},
	{
		name: "test with an argument reads that text",
		text: "",
		probe: "要我继续吗？",
		expect: { sent: undefined, calls: 1, notified: "given text" },
	},
	{
		name: "test on a DONE message never calls the model",
		text: "✓ DONE\n全部完成。",
		probe: "",
		expect: { sent: undefined, calls: 0, notified: "skipped" },
	},
];

let failures = 0;

for (const testCase of CASES) {
	const harness = await createHarness({ modelReply: testCase.modelReply, lastAssistant: testCase.text });
	const { ctx } = harness;
	const momentum = harness.commands.get("momentum")!;

	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
	if (testCase.command) await momentum(testCase.command, ctx);

	let expectedSent = testCase.expect.sent;
	let expectedCalls = testCase.expect.calls ?? 0;

	if (testCase.probe !== undefined) {
		await momentum(`test ${testCase.probe}`.trim(), ctx);
	} else {
		await harness.handlers.get("agent_settled")!(settledEvent(), ctx);
	}

	// The cap case: run until the counter blocks, then check it stopped growing.
	if (testCase.name.includes("cap")) {
		await harness.handlers.get("agent_settled")!(settledEvent(), ctx);
		await harness.handlers.get("agent_settled")!(settledEvent(), ctx);
		await harness.handlers.get("agent_settled")!(settledEvent(), ctx);
		expectedSent = harness.sent[0];
		expectedCalls = 3;
		if (harness.sent.length !== 3) failures++;
	}

	const problems: string[] = [];
	const sentEntries = harness.entries.filter(
		(entry) => (entry.data as { sent?: boolean } | undefined)?.sent === true,
	);

	if ("sent" in testCase.expect && harness.sent[0] !== testCase.expect.sent) {
		problems.push(`sent=${JSON.stringify(harness.sent[0])}`);
	}
	if (expectedCalls !== undefined && harness.completeCalls !== expectedCalls) {
		problems.push(`calls=${harness.completeCalls}`);
	}
	if ("audited" in testCase.expect && (sentEntries.length > 0) !== testCase.expect.audited) {
		problems.push(`audited=${sentEntries.length > 0}`);
	}
	if ("logged" in testCase.expect && (harness.entries.length > 0) !== testCase.expect.logged) {
		problems.push(`logged=${harness.entries.length > 0}`);
	}
	if (testCase.expect.notified && !harness.notifications.some((line) => line.includes(testCase.expect.notified!))) {
		problems.push(`notification missing ${JSON.stringify(testCase.expect.notified)}`);
	}

	const ok = problems.length === 0;
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${testCase.name}${ok ? "" : `  → ${problems.join(" ")}`}`);
}

// Rule normalisation: the user writes a sentence, the model turns it into
// matchable terms, and the guardrail then uses those terms.
{
	const harness = await createHarness({
		ruleReply: '{"rule":"不许改数据库迁移","terms":["数据库迁移","迁移脚本"]}',
		modelReply: '{"action":"continue","reply":"那就跑数据库迁移吧","reason":"它在问"}',
	});
	const { ctx } = harness;
	const momentum = harness.commands.get("momentum")!;
	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);

	await momentum("never add 别让它在没问我之前就跑数据库迁移", ctx);
	const config = loadConfig(PROJECT);
	const stored = config.rules[0];
	const storedOk = stored?.terms?.includes("数据库迁移") === true;
	if (!storedOk) failures++;
	console.log(`${storedOk ? "ok  " : "FAIL"}  never add stores model-derived terms → ${JSON.stringify(stored?.terms)}`);

	// The round trip that matters: a reply echoing the forbidden object is caught.
	const before = harness.sent.length;
	await momentum("on", ctx);
	await harness.handlers.get("agent_settled")!(settledEvent(), ctx);
	const blocked = harness.sent.length === before;
	if (!blocked) failures++;
	console.log(`${blocked ? "ok  " : "FAIL"}  a reply using the forbidden term is not sent`);
}

// --raw keeps the rule exactly as typed.
{
	const harness = await createHarness();
	const { ctx } = harness;
	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
	await harness.commands.get("momentum")!("never add --raw 不要碰 vendor/", ctx);
	const config = loadConfig(PROJECT);
	const raw = config.rules.some((rule) => rule.text === "不要碰 vendor/" && !rule.terms);
	if (!raw) failures++;
	console.log(`${raw ? "ok  " : "FAIL"}  never add --raw stores the text verbatim`);
}

// `/momentum max off` lifts the cap, and the status says so.
{
	const harness = await createHarness();
	const { ctx } = harness;
	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
	await harness.commands.get("momentum")!("on", ctx);
	await harness.commands.get("momentum")!("max off", ctx);
	const shown = harness.statuses.at(-1) === "\u26a1 0/\u221e";
	if (!shown) failures++;
	console.log(`${shown ? "ok  " : "FAIL"}  max off shows an unbounded counter`);
}

// The cap comes from the file when one is set, so a limit can outlive a restart.
{
	const harness = await createHarness();
	const { ctx } = harness;
	mkdirSync(join(process.env.HOME!, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(process.env.HOME!, ".pi", "agent", "momentum.json"),
		JSON.stringify({ global: { maxContinues: "infinite" } }),
	);
	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
	await harness.commands.get("momentum")!("on", ctx);
	const shown = harness.statuses.at(-1) === "\u26a1 0/\u221e";
	writeFileSync(join(process.env.HOME!, ".pi", "agent", "momentum.json"), "{}");
	if (!shown) failures++;
	console.log(`${shown ? "ok  " : "FAIL"}  a maxContinues of \"infinite\" in the file survives a restart`);
}

// `never rm` without an argument asks which rule to drop, and only drops that one.
{
	const harness = await createHarness();
	const { ctx } = harness;
	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
	await harness.commands.get("momentum")!("never add --raw --global 别删库", ctx);
	await harness.commands.get("momentum")!("never add --raw 不要碰 vendor/", ctx);

	harness.selectPick = "vendor";
	await harness.commands.get("momentum")!("never rm", ctx);

	const config = loadConfig(PROJECT);
	const picked = !config.rules.some((rule) => rule.text === "不要碰 vendor/");
	const kept = config.rules.some((rule) => rule.text === "别删库");
	const offered = harness.selectOptions;
	const offeredBoth = offered.some((option) => option.startsWith("[dir]")) &&
		offered.some((option) => option.startsWith("[global]"));
	const ok = picked && kept && offeredBoth && harness.selects === 1;
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  never rm without an argument offers the rules and removes the pick`);
}

// Cancelling the picker changes nothing.
{
	const harness = await createHarness();
	const { ctx } = harness;
	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
	await harness.commands.get("momentum")!("never add --raw 不要碰 vendor/", ctx);

	await harness.commands.get("momentum")!("never rm", ctx);

	const config = loadConfig(PROJECT);
	const kept = config.rules.some((rule) => rule.text === "不要碰 vendor/");
	if (!kept) failures++;
	console.log(`${kept ? "ok  " : "FAIL"}  cancelling the picker removes nothing`);
}

// Autocomplete: the whole point is that `/momentum ` is discoverable.
const probe = await createHarness();
await probe.handlers.get("session_start")!({ type: "session_start" }, probe.ctx);

const autocompleteCases: Array<{ line: string; expect: string[] }> = [
	{ line: "/momentum ", expect: ["on", "off", "test", "never", "dirs", "max", "prompt", "status"] },
	{ line: "/momentum ne", expect: ["never"] },
	{ line: "/momentum never ", expect: ["list", "add", "rm"] },
	{ line: "/momentum never a", expect: ["add"] },
	{ line: "/momentum never add ", expect: [] },
	{ line: "/momentum never add --", expect: ["--global", "--raw"] },
	{ line: "/momentum never add --g", expect: ["--global"] },
	{ line: "/momentum max ", expect: ["1", "2", "3", "5", "10", "off"] },
	{ line: "/momentum zz", expect: [] },
];

for (const testCase of autocompleteCases) {
	const result = await probe.suggestions(testCase.line);
	const values = (result?.items ?? []).map((item) => item.value);
	const ok = JSON.stringify(values) === JSON.stringify(testCase.expect);
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"}  autocomplete ${JSON.stringify(testCase.line)} → ${JSON.stringify(values)}` +
			(ok ? "" : ` (expected ${JSON.stringify(testCase.expect)})`),
	);
}

// Anything that is not /momentum must fall through to the built-in provider.
const passthrough = await probe.suggestions("hello world");
const passthroughOk = passthrough === null;
if (!passthroughOk) failures++;
console.log(`${passthroughOk ? "ok  " : "FAIL"}  autocomplete passes other lines through`);

console.log();
if (failures > 0) {
	console.error(`${failures} case(s) failed`);
	process.exit(1);
}
console.log(`${CASES.length + autocompleteCases.length + 7} smoke cases pass`);
console.log(`  detector: ${analyzeTurnEnd("要我接着做这个吗？").verdict}`);
