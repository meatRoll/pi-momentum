/**
 * Smoke test for the extension plumbing, without booting Pi.
 *
 *   npm test
 *
 * Builds a fake ExtensionAPI + ExtensionContext, captures what the extension
 * registers, and drives the gate through the cases that matter.
 */

import { analyzeTurnEnd } from "../src/detect.ts";
import momentumExtension from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	commands: Map<string, Handler>;
	sent: string[];
	entries: Array<{ type: string; data: unknown }>;
	notifications: string[];
	statuses: Array<string | undefined>;
	completeCalls: number;
	/** Suggestions the autocomplete provider returns for a given editor line. */
	suggestions: (line: string) => Promise<{ prefix: string; items: Array<{ value: string }> } | null>;
	ctx: never;
}

interface HarnessOptions {
	/** Raw text the virtual-user model call returns. */
	modelReply?: string;
	/** Assistant text on the session branch. */
	lastAssistant?: string;
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
	const counters = { completeCalls: 0 };
	const autocomplete: Array<(current: unknown) => unknown> = [];

	const current = {
		getSuggestions: async () => null,
		applyCompletion: (lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 }),
		shouldTriggerFileCompletion: () => true,
	};

	const ctx = {
		cwd: process.cwd(),
		model: { id: "fake-model", provider: "fake" },
		modelRegistry: {
			find: () => undefined,
			complete: async () => {
				counters.completeCalls += 1;
				return {
					content: [{ type: "text", text: options.modelReply ?? CONTINUE_JSON }],
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

// Autocomplete: the whole point is that `/momentum ` is discoverable.
const probe = await createHarness();
await probe.handlers.get("session_start")!({ type: "session_start" }, probe.ctx);

const autocompleteCases: Array<{ line: string; expect: string[] }> = [
	{ line: "/momentum ", expect: ["on", "off", "test", "never", "max", "prompt", "status"] },
	{ line: "/momentum ne", expect: ["never"] },
	{ line: "/momentum never ", expect: ["list", "add", "rm"] },
	{ line: "/momentum never a", expect: ["add"] },
	{ line: "/momentum max ", expect: ["1", "2", "3", "5", "10"] },
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
console.log(`${CASES.length + autocompleteCases.length + 1} smoke cases pass`);
console.log(`  detector: ${analyzeTurnEnd("要我接着做这个吗？").verdict}`);
