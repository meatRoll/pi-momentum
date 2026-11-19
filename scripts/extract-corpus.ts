/**
 * Extract a turn-end corpus from a Pi session transcript.
 *
 *   npm run corpus -- [session.jsonl] [--out fixtures/corpus/<id>.json]
 *
 * A "turn end" is the last assistant text message before the next user message.
 * That is the moment where the gate would have fired.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface CorpusTurn {
	/** Zero-based position in the corpus. */
	index: number;
	/** Entry index in the session file. */
	entry: number;
	/** Assistant text that ended the turn, truncated. */
	finalText: string;
	/** What the user actually typed next, truncated. */
	userReply: string;
	/** True when the reply carries no decision (继续 / 可以 / 做吧 …). */
	ack: boolean;
}

export interface Corpus {
	source: string;
	sessionId: string;
	cwd: string;
	generatedAt: string;
	turnCount: number;
	turns: CorpusTurn[];
}

const ACK_MAX_CHARS = 12;
const TEXT_LIMIT = 2000;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const { type, text } = block as { type?: string; text?: string };
			return type === "text" ? (text ?? "") : "";
		})
		.join("");
}

export function readSession(sessionPath: string): Corpus {
	const raw = readFileSync(sessionPath, "utf8");
	let entry = 0;
	const messages: Array<{ entry: number; role: string; text: string; virtual?: boolean }> = [];
	// A virtual reply is an appendEntry() immediately before the user message.
	let pendingVirtual = false;
	let sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
	let cwd = "";

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.type === "session") {
			sessionId = String(parsed.id ?? sessionId);
			cwd = String(parsed.cwd ?? "");
			continue;
		}
		if (parsed.type === "custom") {
			if (parsed.customType === "pi-momentum/virtual-reply") pendingVirtual = true;
			continue;
		}
		if (parsed.type !== "message") continue;
		const message = parsed.message as { role?: string; content?: unknown } | undefined;
		const role = message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(message?.content);
		if (!text.trim()) continue;
		const virtual = role === "user" ? pendingVirtual : false;
		if (role === "user") pendingVirtual = false;
		messages.push({ entry: entry++, role, text, virtual });
	}

	const turns: CorpusTurn[] = [];
	for (let k = 1; k < messages.length; k++) {
		const next = messages[k];
		if (next.role !== "user") continue;
		let j = k - 1;
		while (j >= 0 && messages[j].role !== "assistant") j--;
		if (j < 0) continue;
		const final = messages[j];
		if (!final.text.trim()) continue;
		const reply = next.text.trim();
		turns.push({
			index: turns.length,
			entry: final.entry,
			finalText: final.text.slice(-TEXT_LIMIT),
			userReply: reply.slice(0, 200),
			ack: reply.length <= ACK_MAX_CHARS,
		});
	}

	return {
		source: resolve(sessionPath),
		sessionId,
		cwd,
		generatedAt: new Date().toISOString(),
		turnCount: turns.length,
		turns,
	};
}

function main(): void {
	const args = process.argv.slice(2);
	const sessionPath = args.find((arg) => !arg.startsWith("--"));
	if (!sessionPath) {
		console.error("usage: extract-corpus.ts <session.jsonl> [--out <file>]");
		process.exit(1);
	}

	const corpus = readSession(sessionPath);
	const outFlag = args.indexOf("--out");
	const outPath =
		outFlag >= 0 && args[outFlag + 1]
			? resolve(args[outFlag + 1]!)
			: resolve("fixtures/corpus", `${corpus.sessionId}.json`);

	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`);

	const ack = corpus.turns.filter((turn) => turn.ack).length;
	console.log(`wrote ${outPath}`);
	console.log(`  turns: ${corpus.turnCount}  ack replies: ${ack} (${Math.round((100 * ack) / corpus.turnCount)}%)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
