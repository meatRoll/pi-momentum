/**
 * Smoke test for the extension plumbing, without booting Pi.
 *
 *   npm test
 *
 * Builds a fake ExtensionAPI + ExtensionContext, captures what the extension
 * registers, and drives both modes through the cases that matter.
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
	const state = { completeCalls: 0 };

	const ctx = {
		cwd: process.cwd(),
		model: { id: "fake-model", provider: "fake" },
		modelRegistry: {
			find: () => undefined,
			complete: async () => {
				state.completeCalls += 1;
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
	return {
		handlers,
		commands,
		sent,
		entries,
		notifications,
		statuses,
		get completeCalls() {
			return state.completeCalls;
		},
		ctx: ctx as never,
	} as Harness;
}

function settleEvent(text: string): unknown {
	return {
		type: "agent_before_settle",
		outcome: "completed",
		continue: false,
		entries: [],
		context: {
			contextMessages: [{ role: "assistant", content: [{ type: "text", text }] }],
			canContinue: true,
			contextEntries: [],
			llmMessages: [],
			pendingMessages: [],
		},
	};
}

function settledEvent(): unknown {
	return { type: "agent_settled", aborted: false };
}

interface Case {
	name: string;
	/** Mode command, e.g. "nudge" or "virtual". */
	mode: "nudge" | "virtual";
	text: string;
	modelReply?: string;
	expect: {
		/** nudge: continue flag from the boundary handler. */
		continued?: boolean;
		/** virtual: user message injected. */
		sent?: string;
		/** virtual: model call happened at all. */
		calls?: number;
		/** virtual: a decision entry with sent=true was written. */
		audited?: boolean;
		/** virtual: any decision entry was written (dry-run included). */
		logged?: boolean;
		/** notification substring */
		notified?: string;
	};
	/** Run `/momentum test <probe>` instead of the settle flow. */
	probe?: string;
	/** Switch to dry-run before settling. */
	dryRun?: boolean;
}

const CASES: Case[] = [
	{
		name: "nudge: permission question continues",
		mode: "nudge",
		text: "提交：`2a44e0a`，190 测试绿。\n\n要我接着做这个吗？",
		expect: { continued: true },
	},
	{
		name: "nudge: BLOCKED is respected",
		mode: "nudge",
		text: "⏸ BLOCKED\n卡点：要不要清掉 470MB 中间产物",
		expect: { continued: false },
	},
	{
		name: "nudge: DONE is respected",
		mode: "nudge",
		text: "✓ DONE\n190 测试绿。",
		expect: { continued: false },
	},
	{
		name: "virtual: model says continue, reply is written as the user",
		mode: "virtual",
		text: "下一步我建议先把 op50 的读取地址补上。要我继续吗？",
		expect: { sent: "继续", calls: 1, audited: true },
	},
	{
		name: "virtual: model says stop, nothing is sent",
		mode: "virtual",
		text: "190 测试绿，工作区干净。",
		modelReply: STOP_JSON,
		expect: { sent: undefined, calls: 1 },
	},
	{
		name: "virtual: reply touching the never-list is dropped",
		mode: "virtual",
		text: "需要我装一下 Ghidra 吗？",
		modelReply: '{"action":"continue","reply":"装一下新软件","reason":"它在问"}',
		expect: { sent: undefined, calls: 1, audited: false },
	},
	{
		name: "virtual: BLOCKED skips the model call entirely",
		mode: "virtual",
		text: "⏸ BLOCKED\n要不要清掉 470MB 中间产物",
		expect: { sent: undefined, calls: 0 },
	},
	{
		name: "virtual dry-run logs the decision but sends nothing",
		mode: "virtual",
		text: "要我接着做这个吗？",
		dryRun: true,
		expect: { sent: undefined, calls: 1, audited: false, logged: true },
	},
	{
		name: "test command probes the decision without sending anything",
		mode: "virtual",
		probe: "要我接着做这个吗？",
		expect: { sent: undefined, calls: 1, notified: "action: continue" },
	},
	{
		name: "test command surfaces a guardrail rejection",
		mode: "virtual",
		probe: "要不要重装一下依赖包？",
		modelReply: '{"action":"continue","reply":"重装一下依赖包","reason":"x"}',
		expect: { sent: undefined, calls: 1, notified: "would send: no" },
	},
];

let failures = 0;

for (const testCase of CASES) {
	const harness = await createHarness({ modelReply: testCase.modelReply, lastAssistant: testCase.text });
	const { ctx } = harness;
	const momentum = harness.commands.get("momentum")!;
	const settle = harness.handlers.get("agent_before_settle")!;

	await harness.handlers.get("session_start")!({ type: "session_start" }, ctx);
	await momentum(testCase.mode, ctx);
	if (testCase.dryRun) await momentum("dry", ctx);

	let continued: boolean | undefined;
	if (testCase.probe) {
		await momentum(`test ${testCase.probe}`, ctx);
	} else if (testCase.mode === "nudge") {
		const result = (await settle(settleEvent(testCase.text), ctx)) as { continue?: boolean } | undefined;
		continued = result?.continue === true;
	} else {
		await harness.handlers.get("agent_settled")!(settledEvent(), ctx);
	}

	const problems: string[] = [];
	if ("continued" in testCase.expect && continued !== testCase.expect.continued) {
		problems.push(`continued=${continued}`);
	}
	if ("sent" in testCase.expect && harness.sent[0] !== testCase.expect.sent) {
		problems.push(`sent=${JSON.stringify(harness.sent[0])}`);
	}
	if ("calls" in testCase.expect && harness.completeCalls !== testCase.expect.calls) {
		problems.push(`calls=${harness.completeCalls}`);
	}
	const sentEntries = harness.entries.filter((entry) => (entry.data as { sent?: boolean } | undefined)?.sent === true);
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

console.log();
if (failures > 0) {
	console.error(`${failures} case(s) failed`);
	process.exit(1);
}
console.log(`${CASES.length}/${CASES.length} smoke cases pass`);
console.log(`  detector: ${analyzeTurnEnd("要我接着做这个吗？").verdict}`);
