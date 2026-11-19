/**
 * Score the turn-end detector against real session data.
 *
 *   npm run analyze                     # newest corpus in fixtures/corpus
 *   npm run analyze -- --session <path> # ad-hoc session transcript
 *   npm run analyze -- --selftest       # detector regression cases
 *
 * "Wasted turns" are turn-ends the gate would have continued *and* whose user
 * reply carried no decision (继续 / 可以 / 做吧 …). That is the number this
 * plugin exists to remove.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeTurnEnd, type Verdict } from "../src/detect.ts";
import { readSession, type Corpus } from "./extract-corpus.ts";

interface Row {
	index: number;
	verdict: Verdict;
	ack: boolean;
	tail: string;
	reply: string;
	reason: string;
}

function newestCorpus(dir: string): string {
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => resolve(dir, name))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	if (files.length === 0) throw new Error(`no corpus in ${dir}; run: npm run corpus -- <session.jsonl>`);
	return files[0]!;
}

function loadCorpus(path: string): Corpus {
	return JSON.parse(readFileSync(path, "utf8")) as Corpus;
}

function percent(part: number, total: number): string {
	return total === 0 ? "0%" : `${Math.round((100 * part) / total)}%`;
}

function bar(part: number, total: number, width = 28): string {
	const filled = total === 0 ? 0 : Math.round((width * part) / total);
	return `${"█".repeat(filled)}${"·".repeat(width - filled)}`;
}

function pct(part: number, total: number): string {
	return percent(part, total);
}

function report(corpus: Corpus): void {
	const rows: Row[] = corpus.turns.map((turn) => {
		const analysis = analyzeTurnEnd(turn.finalText);
		return {
			index: turn.index,
			verdict: analysis.verdict,
			ack: turn.ack,
			tail: analysis.tail,
			reply: turn.userReply,
			reason: analysis.reason,
		};
	});

	const total = rows.length;
	const continued = rows.filter((row) => row.verdict === "continue");
	const blocked = rows.filter((row) => row.verdict === "blocked");
	const done = rows.filter((row) => row.verdict === "done");
	const askedAtEnd = rows.filter((row) =>
		analyzeTurnEnd(corpus.turns[row.index]!.finalText).endsWithQuestion,
	);
	const askedAndAck = askedAtEnd.filter((row) => row.ack);
	const silentAndAck = continued.filter((row) => row.ack && !askedAtEnd.includes(row));
	const wasted = continued.filter((row) => row.ack);

	console.log(`\nsession  ${corpus.sessionId}`);
	console.log(`turns    ${total}\n`);

	console.log("verdicts");
	console.log(`  continue  ${String(continued.length).padStart(4)}  ${pct(continued.length, total).padStart(4)}  ${bar(continued.length, total)}`);
	console.log(`  blocked   ${String(blocked.length).padStart(4)}  ${pct(blocked.length, total).padStart(4)}  ${bar(blocked.length, total)}`);
	console.log(`  done      ${String(done.length).padStart(4)}  ${pct(done.length, total).padStart(4)}  ${bar(done.length, total)}`);

	console.log("\nsignal");
	console.log(`  turns ending in a question           ${String(askedAtEnd.length).padStart(4)}  ${pct(askedAtEnd.length, total)}`);
	console.log(`  asked, then got a one-word reply     ${String(askedAndAck.length).padStart(4)}  ${pct(askedAndAck.length, askedAtEnd.length)} of questions`);
	console.log(`  stopped silently, then "continue"    ${String(silentAndAck.length).padStart(4)}  ${pct(silentAndAck.length, total)}`);
	console.log(`  gate would continue                  ${String(continued.length).padStart(4)}  ${pct(continued.length, total)}`);

	console.log(
		`\nwasted turns removable: ${wasted.length} / ${total} (${pct(wasted.length, total)})` +
			`\n  of which the agent had asked a question anyway: ${askedAndAck.length}` +
			`\nuser keystrokes saved:   ${wasted.length} of ${corpus.turns.filter((t) => t.ack).length} one-word replies\n`,
	);


	const sample = (label: string, list: Row[], limit = 5): void => {
		if (list.length === 0) return;
		console.log(`${label}`);
		for (const row of list.slice(0, limit)) {
			console.log(`  #${String(row.index).padStart(3)}  ${row.tail.slice(0, 78)}`);
			console.log(`        reply: ${row.reply.slice(0, 40)}`);
		}
		console.log();
	};

	sample("would continue (sample)", continued);
	sample("would block (sample)", blocked);
	if (done.length > 0) sample("would stop as done (sample)", done);
}

const SELFTEST_CASES: Array<{ name: string; text: string; expect: Verdict }> = [
	{ name: "plain permission question", text: "提交：`2a44e0a`，190 测试绿。\n\n要我接着做这个吗？", expect: "continue" },
	{ name: "question with recommendation", text: "我建议走表驱动。\n\n要继续吗？", expect: "continue" },
	{ name: "bare status, no next step", text: "工作区干净。", expect: "continue" },
	{ name: "blocked marker", text: "⏸ BLOCKED\n卡点：要不要清掉 470MB 中间产物。\n候选：A 清 / B 留\n推荐：A（可重建）", expect: "blocked" },
	{ name: "done marker", text: "✓ DONE\n190 测试绿，工作区干净。", expect: "done" },
	{ name: "question inside a code fence is not a question", text: "结论如下：\n```\n要我继续吗？\n```", expect: "continue" },
];

function selftest(): void {
	let failed = 0;
	for (const testCase of SELFTEST_CASES) {
		const analysis = analyzeTurnEnd(testCase.text);
		const ok = analysis.verdict === testCase.expect;
		if (!ok) failed++;
		console.log(`${ok ? "ok  " : "FAIL"}  ${testCase.name}  → ${analysis.verdict} (expected ${testCase.expect})`);
	}
	if (failed > 0) {
		console.error(`\n${failed} case(s) failed`);
		process.exit(1);
	}
	console.log(`\n${SELFTEST_CASES.length}/${SELFTEST_CASES.length} cases pass`);
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.includes("--selftest")) {
		selftest();
		return;
	}

	const sessionFlag = args.indexOf("--session");
	const corpus =
		sessionFlag >= 0 && args[sessionFlag + 1]
			? readSession(resolve(args[sessionFlag + 1]!))
			: loadCorpus(newestCorpus(resolve("fixtures/corpus")));

	report(corpus);
}

main();
