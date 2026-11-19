/**
 * Smoke test for the extension plumbing, without booting Pi.
 *
 *   npm test
 *
 * Builds a fake ExtensionAPI, captures the handlers the extension registers,
 * and drives the turn-end gate through the cases that matter.
 */

import momentumExtension from "../src/index.ts";
import { analyzeTurnEnd } from "../src/detect.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	notifications: string[];
	statuses: Array<string | undefined>;
	commands: Map<string, Handler>;
	flags: Set<string>;
	ctx: never;
}

function createHarness(): Harness {
	const handlers = new Map<string, Handler>();
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const commands = new Map<string, Handler>();
	const flags = new Set<string>();

	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, options: { handler: Handler }) => {
			commands.set(name, options.handler);
		},
		registerFlag: (name: string) => {
			flags.add(name);
		},
	};

	momentumExtension(pi as never);

	const ctx = {
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			setStatus: (_key: string, text: string | undefined) => {
				statuses.push(text);
			},
		},
	} as never;

	return { handlers, notifications, statuses, commands, flags, ctx };
}

function assistantMessage(text: string): unknown {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function settleEvent(text: string, entries: unknown[] = []): unknown {
	return {
		type: "agent_before_settle",
		outcome: "completed",
		continue: false,
		entries,
		context: {
			contextMessages: [assistantMessage(text)],
			canContinue: true,
			contextEntries: [],
			llmMessages: [],
			pendingMessages: [],
		},
	};
}

interface Case {
	name: string;
	text: string;
	expectContinue: boolean;
	enforce?: boolean;
}

const CASES: Case[] = [
	{
		name: "permission question is continued",
		text: "提交：`2a44e0a`，190 测试绿。\n\n要我接着做这个吗？",
		expectContinue: true,
		enforce: true,
	},
	{
		name: "silent status report is continued",
		text: "工作区干净，184 测试绿。",
		expectContinue: true,
		enforce: true,
	},
	{
		name: "BLOCKED is respected",
		text: "⏸ BLOCKED\n卡点：要不要清掉 470MB 中间产物\n候选：A 清 / B 留\n推荐：A，但删除不可逆，需要你确认。",
		expectContinue: false,
		enforce: true,
	},
	{
		name: "DONE is respected",
		text: "✓ DONE\n190 测试绿，工作区干净。",
		expectContinue: false,
		enforce: true,
	},
	{
		name: "dry-run never injects",
		text: "要我接着做这个吗？",
		expectContinue: false,
		enforce: false,
	},
];

let failures = 0;

for (const testCase of CASES) {
	const harness = createHarness();
	const { ctx } = harness;
	const reset = harness.handlers.get("before_agent_start");
	const settle = harness.handlers.get("agent_before_settle");
	const momentumCommand = harness.commands.get("momentum");
	if (!reset || !settle || !momentumCommand) {
		console.error("FAIL  extension did not register its handlers/command");
		failures++;
		continue;
	}

	// The extension starts in dry-run; flip it to enforce the way a user would.
	if (testCase.enforce) await momentumCommand("enforce", ctx);

	// Reset the per-turn counter the way a real user prompt does.
	await reset(
		{ messageType: "user", prompt: testCase.name, systemPrompt: "", systemPromptOptions: {} },
		ctx,
	);

	const result = (await settle(settleEvent(testCase.text), ctx)) as
		| { entries?: unknown[]; continue?: boolean }
		| undefined;

	const continued = result?.continue === true;
	const ok = continued === testCase.expectContinue;
	if (!ok) failures++;
	console.log(
		`${ok ? "ok  " : "FAIL"}  ${testCase.name}  → ${continued ? "continued" : "stopped"}` +
			` (expected ${testCase.expectContinue ? "continued" : "stopped"})`,
	);
}

console.log();
if (failures > 0) {
	console.error(`${failures} case(s) failed`);
	process.exit(1);
}
console.log(`${CASES.length}/${CASES.length} smoke cases pass`);
console.log(`  detector sees: ${analyzeTurnEnd("要我接着做这个吗？").verdict}`);
