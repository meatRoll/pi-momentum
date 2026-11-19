/**
 * Unit cases for the virtual-user decision layer.
 *
 *   node --experimental-strip-types test/virtual.ts
 */

import { buildSystemPrompt, neverTerms, parseDecision, sanitizeReply } from "../src/virtual.ts";

interface Case {
	name: string;
	run: () => boolean;
}

const cases: Case[] = [
	{
		name: "plain JSON continue is accepted",
		run: () => {
			const d = parseDecision('{"action":"continue","reply":"继续","reason":"在等确认"}');
			return d.action === "continue" && d.reply === "继续";
		},
	},
	{
		name: "fenced JSON is accepted",
		run: () => parseDecision('```json\n{"action":"continue","reply":"按 A 做","reason":"它推荐 A"}\n```').reply === "按 A 做",
	},
	{
		name: "JSON with trailing prose is accepted",
		run: () =>
			parseDecision('{"action":"continue","reply":"继续","reason":"x"}\n\n以上是我会说的话。').reply === "继续",
	},
	{
		name: "stop carries no reply",
		run: () => {
			const d = parseDecision('{"action":"stop","reply":"继续","reason":"已完成"}');
			return d.action === "stop" && d.reply === "";
		},
	},
	{
		name: "unknown action degrades to stop",
		run: () => parseDecision('{"action":"maybe","reply":"继续","reason":""}').action === "stop",
	},
	{
		name: "garbage degrades to stop",
		run: () => parseDecision("我觉得可以继续").action === "stop",
	},
	{
		name: "truncated JSON degrades to stop",
		run: () => parseDecision('{"action":"continue","reply":"继').action === "stop",
	},
	{
		name: "reply ending in a question is rejected",
		run: () => sanitizeReply("要我继续吗？") === "",
	},
	{
		name: "reply asking to install software is rejected",
		run: () => sanitizeReply("装一下新软件") === "",
	},
	{
		name: "reply asking to delete data is rejected",
		run: () => sanitizeReply("先把中间产物清掉") === "",
	},
	{
		name: "reply asking to push is rejected",
		run: () => sanitizeReply("push 到远程") === "",
	},
	{
		name: "user never-rule is enforced as a literal",
		run: () => sanitizeReply("按路线 A 做，先改 web 层", ["web 层"]) === "",
	},
	{
		name: "a prohibition rule blocks the action it forbids",
		run: () => sanitizeReply("那就改数据库迁移吧", ["不许改数据库迁移"]) === "",
	},
	{
		name: "a rule naming an object blocks touching that object",
		run: () => sanitizeReply("先动 vendor/ 里的文件", ["不要碰 vendor/"]) === "",
	},
	{
		name: "a rule with a comma list splits into separate terms",
		run: () => neverTerms(["不要碰 vendor/，别删数据"]).includes("vendor/"),
	},
	{
		name: "neverTerms keeps the protected object of a prohibition",
		run: () => {
			const terms = neverTerms(["不许改数据库迁移"]);
			return terms.includes("数据库迁移") && terms.includes("改数据库迁移");
		},
	},
	{
		name: "ordinary reply survives the guardrails",
		run: () => sanitizeReply("继续，按你说的 A 方案") === "继续，按你说的 A 方案",
	},
	{
		name: "long replies are truncated, not dropped",
		run: () => sanitizeReply("继续按你刚才给出的那个推荐方案往下推进不要停下来问").length <= 40,
	},
	{
		name: "prompt carries the never list",
		run: () => buildSystemPrompt(["不要碰数据库"]).includes("不要碰数据库"),
	},
];

let failures = 0;
for (const testCase of cases) {
	let ok = false;
	try {
		ok = testCase.run();
	} catch (error) {
		console.log(`FAIL  ${testCase.name}  → threw ${String(error)}`);
		failures++;
		continue;
	}
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${testCase.name}`);
}

console.log();
if (failures > 0) {
	console.error(`${failures} case(s) failed`);
	process.exit(1);
}
console.log(`${cases.length}/${cases.length} virtual-layer cases pass`);
