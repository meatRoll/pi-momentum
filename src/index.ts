/**
 * pi-momentum — a turn-end gate for Pi.
 *
 * Two modes:
 *
 *   nudge    inject a fixed instruction telling the agent to keep going
 *   virtual  read the last assistant message, decide whether it is waiting on
 *            the user, and if so speak one line in the user's voice
 *
 * Both stop when the agent declares `⏸ BLOCKED` or `✓ DONE`.
 *
 * Load with:  pi -e ./src/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addNever, loadConfig, type MomentumConfig, originLabel, removeNever } from "./config.ts";
import { analyzeTurnEnd, BLOCK_MARKER, continuationPrompt, DONE_MARKER } from "./detect.ts";
import { RULES, SECTION_TAG } from "./rules.ts";
import { buildSystemPrompt, DEFAULT_NEVER, type Decision, parseDecision } from "./virtual.ts";
import { VERSION } from "./version.ts";

const CONTINUE_CUSTOM_TYPE = "pi-momentum/continue";
/** Every decision, dry or sent. Renders in the transcript, never enters LLM context. */
const DECISION_ENTRY_TYPE = "pi-momentum/decision";
const MAX_DEFAULT = 3;

interface DecisionEntry {
	dry: boolean;
	/** True only when the reply was actually injected as a user message. */
	sent: boolean;
	action: "continue" | "stop" | "skip";
	reply: string;
	reason: string;
	/** The assistant text the decision was made on. */
	input: string;
	raw?: string;
	/** Offending line, when the pre-filter skipped the call. */
	detail?: string;
	model?: string;
	ms: number;
}

function preview(text: string, limit = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

type Mode = "off" | "nudge" | "virtual";

interface MomentumState {
	mode: Mode;
	/** Decide but never send. */
	dryRun: boolean;
	maxContinues: number;
	/** Continuations fired in the current user turn. */
	continues: number;
	config: MomentumConfig;
	/** Last reply we injected, so a re-entrant prompt is not mistaken for a human. */
	lastSentReply?: string;
}

const DEFAULT_STATE: Omit<MomentumState, "config"> = {
	mode: "off",
	dryRun: true,
	maxContinues: MAX_DEFAULT,
	continues: 0,
};

/** Text blocks of a message content value. */
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

/** Last assistant text in a projected message list (nudge mode / boundary event). */
function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown } | undefined;
		if (!message || message.role !== "assistant") continue;
		return textOf(message.content);
	}
	return "";
}

/** Last assistant text on the current branch (virtual mode / settled event). */
function lastAssistantTextFromBranch(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") continue;
		const message = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role !== "assistant") continue;
		return textOf(message.content);
	}
	return "";
}

function statusText(state: MomentumState): string | undefined {
	if (state.mode === "off") return undefined;
	if (state.mode === "virtual") return `⚡ virtual ${state.continues}/${state.maxContinues}`;
	return `⚡ nudge ${state.continues}/${state.maxContinues}`;
}

function refreshStatus(state: MomentumState, ctx: ExtensionContext): void {
	ctx.ui.setStatus("momentum", statusText(state));
}

function stop(status: string, ctx: ExtensionContext): void {
	ctx.ui.setStatus("momentum", `⚡ ${status}`);
}

export default async function momentumExtension(pi: ExtensionAPI): Promise<void> {
	// Only available inside Pi. Offline tests must not need it, and a renderer is
	// a convenience: the extension works without one.
	const tui = (await import("@earendil-works/pi-tui").catch(() => undefined)) as
		| { Box: new (...args: never[]) => unknown; Text: new (...args: never[]) => unknown }
		| undefined;

	const state: MomentumState = { ...DEFAULT_STATE, config: { never: [] } };

	function resolveModel(ctx: ExtensionContext) {
		const spec = state.config.model;
		if (spec) {
			const slash = spec.indexOf("/");
			if (slash > 0) {
				const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
				if (found) return found;
			}
		}
		return ctx.model;
	}

	/**
	 * One isolated call: system prompt is the intent reader, the single user
	 * message is the agent's last words. Nothing else of the conversation
	 * reaches the decision.
	 */
	async function askVirtualUser(
		ctx: ExtensionContext,
		text: string,
	): Promise<{ decision: Decision; raw: string }> {
		const model = resolveModel(ctx);
		if (!model) return { decision: { action: "stop", reply: "", reason: "no model available" }, raw: "" };

		let raw = "";
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: buildSystemPrompt(state.config.never),
					messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
				} as never,
				{},
			);
			if (response.stopReason === "aborted" || response.stopReason === "error") {
				return { decision: { action: "stop", reply: "", reason: `model ${response.stopReason}` }, raw };
			}
			raw = textOf(response.content);
		} catch (error) {
			return { decision: { action: "stop", reply: "", reason: `call failed: ${String(error)}` }, raw };
		}
		return { decision: parseDecision(raw, state.config.never), raw };
	}

	// Dry-run needs a durable artifact, not a transient notify: a decision you
	// cannot go back and read is a decision you cannot evaluate.
	if (tui) pi.registerEntryRenderer<DecisionEntry>(DECISION_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		const { Box, Text } = tui as never as Record<string, never> as {
			Box: new (a: number, b: number, c: (t: string) => string) => { addChild: (n: unknown) => void };
			Text: new (t: string, a?: number, b?: number) => unknown;
		};
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const status = data.dry
			? theme.fg("warning", "dry")
			: data.sent
				? theme.fg("success", "sent")
				: theme.fg("dim", "stopped");
		const head =
			data.action === "continue"
				? `${theme.bold(theme.fg("accent", "momentum"))} ${status} → ${theme.bold(`“${data.reply}”`)}`
				: `${theme.bold(theme.fg("accent", "momentum"))} ${status} · ${data.action}`;
		box.addChild(new Text(head, 0, 0));
		box.addChild(
			new Text(
				theme.fg(
					"dim",
					`${data.reason || "no reason"} · ${data.ms}ms${data.model ? ` · ${data.model}` : ""}`,
				),
				0,
				0,
			),
		);
		if (expanded) {
			box.addChild(new Text(theme.fg("muted", `in:  ${data.input}`), 0, 0));
			if (data.detail) box.addChild(new Text(theme.fg("muted", `hit: ${data.detail}`), 0, 0));
			if (data.raw) box.addChild(new Text(theme.fg("muted", `raw: ${data.raw}`), 0, 0));
		}
		return box;
	});

	pi.registerFlag("momentum", {
		description: "pi-momentum: continue runs until the agent declares BLOCKED or DONE",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("momentum", {
		description:
			"pi-momentum: virtual | nudge | off | dry | send | max <n> | never list|add|rm | status",
		handler: async (args, ctx) => {
			const [verb = "status", ...rest] = args.trim().split(/\s+/);
			const value = rest.join(" ").trim();

			switch (verb) {
				case "virtual":
					state.mode = "virtual";
					state.dryRun = false;
					state.continues = 0;
					break;
				case "nudge":
					state.mode = "nudge";
					state.dryRun = false;
					state.continues = 0;
					break;
				case "off":
					state.mode = "off";
					break;
				case "dry":
					state.mode = state.mode === "off" ? "virtual" : state.mode;
					state.dryRun = true;
					ctx.ui.notify(
						"momentum: dry-run armed — decisions are logged the next time the agent stops. Use /momentum test for an immediate probe.",
						"info",
					);
					break;
				case "send":
					state.dryRun = false;
					break;
				case "max": {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed) || parsed < 0) {
						ctx.ui.notify("Usage: /momentum max <n>", "warning");
						return;
					}
					state.maxContinues = parsed;
					break;
				}
				case "test": {
					// No argument: simulate the reply for the conversation as it stands.
					// This is the only way to see a decision without waiting for a stop.
					const explicit = rest.join(" ").trim();
					const text = explicit || lastAssistantTextFromBranch(ctx);
					if (!text.trim()) {
						ctx.ui.notify("momentum: no assistant message to test yet", "warning");
						return;
					}
					const source = explicit ? "given text" : "last assistant message";
					const quick = analyzeTurnEnd(text);
					if (quick.verdict !== "continue") {
						ctx.ui.notify(
							`momentum test (${source})\n  skipped: agent declared ${quick.verdict.toUpperCase()} — no model call\n  in: ${preview(text, 160)}`,
							"info",
						);
						return;
					}
					const { decision, raw } = await askVirtualUser(ctx, text);
					ctx.ui.notify(
						[
							`momentum test (${source})`,
							`  action: ${decision.action}`,
							`  reply:  ${decision.reply ? `"${decision.reply}"` : "(none)"}`,
							`  reason: ${decision.reason || "(none)"}`,
							`  would send: ${decision.action === "continue" ? "yes" : "no"}`,
							`  in: ${preview(text, 160)}`,
							`  raw: ${raw.slice(0, 400).replace(/\s+/g, " ")}`,
						].join("\n"),
						"info",
					);
					break;
				}
				case "prompt": {
					ctx.ui.notify(buildSystemPrompt(state.config.never), "info");
					break;
				}
				case "never": {
					const [action = "list", ...words] = rest;
					// --repo is accepted as a synonym: the local layer is the repo layer.
					const scope = words.includes("--global") ? "global" : "local";
					const entry = words
						.filter((word) => !word.startsWith("--"))
						.join(" ")
						.trim();

					if (action === "add" && entry) {
						const path = addNever(state.config, ctx.cwd, entry, scope);
						state.config = loadConfig(ctx.cwd);
						ctx.ui.notify(`momentum: wrote ${path}`, "info");
					} else if (action === "rm" && entry) {
						const path = removeNever(state.config, entry);
						if (!path) {
							ctx.ui.notify(`Not in the list: ${entry}`, "warning");
							return;
						}
						state.config = loadConfig(ctx.cwd);
						ctx.ui.notify(`momentum: removed from ${path}`, "info");
					}

					const localLayers = state.config.layers.filter((layer) => !layer.global);
					const lines = state.config.rules.map(
						(rule) => `  [${originLabel(rule, ctx.cwd)}] ${rule.text}`,
					);
					ctx.ui.notify(
						`momentum never-rules (${localLayers.length} local layer${localLayers.length === 1 ? "" : "s"}` +
							`${state.config.replace ? ", shallower lists replaced" : ""}):\n` +
							(lines.length > 0 ? lines.join("\n") : "  (none — built-in defaults still apply)"),
						"info",
					);
					break;
				}
				default:
					break;
			}
			refreshStatus(state, ctx);
			const builtin = `${DEFAULT_NEVER.length} built-in`;
			ctx.ui.notify(
				`momentum v${VERSION}: ${state.mode}${state.dryRun ? " (dry-run, nothing is sent)" : ""} · max ${state.maxContinues} · ` +
					(state.config.never.length === 0
						? `no never-rules set (${builtin} still active)`
						: `${state.config.never.length} never-rules + ${builtin}`),
				"info",
			);
		},
	});

	// A real human prompt is the only thing that resets the cap. Our own injected
	// message arrives with source "extension", so it does not clear the counter.
	pi.on("input", async (event) => {
		if (event.source === "interactive") {
			state.continues = 0;
			state.lastSentReply = undefined;
		}
	});

	// Inject the contract. Even in virtual mode this pays for itself: an agent
	// that declares BLOCKED/DONE skips the model call entirely.
	pi.on("before_agent_start", async (event) => {
		if (state.mode === "off") return;
		const options = event.systemPromptOptions;
		if (options?.sections) {
			options.sections[SECTION_TAG] = RULES;
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${RULES}` };
	});

	// nudge mode: fixed instruction, decided synchronously at the boundary.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (state.mode !== "nudge") return;
		if (event.outcome !== "completed" || !event.context.canContinue) return;
		if (state.continues >= state.maxContinues) {
			stop("capped", ctx);
			return;
		}

		const text = lastAssistantText(event.context.contextMessages);
		if (!text.trim()) return;

		const analysis = analyzeTurnEnd(text);
		if (analysis.verdict !== "continue") return;

		if (state.dryRun) {
			ctx.ui.notify(`momentum[dry]: would nudge — ${analysis.reason}`, "info");
			return;
		}

		state.continues += 1;
		refreshStatus(state, ctx);
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: CONTINUE_CUSTOM_TYPE,
					content: continuationPrompt(analysis),
					display: false,
				},
			],
			continue: true,
		};
	});

	// virtual mode: read the last words, speak one line in the user's voice.
	pi.on("agent_settled", async (event, ctx) => {
		if (state.mode !== "virtual" || event.aborted) return;
		if (!ctx.isIdle()) return;
		if (state.continues >= state.maxContinues) {
			stop("capped", ctx);
			return;
		}

	const text = lastAssistantTextFromBranch(ctx);
		if (!text.trim()) return;

		const model = resolveModel(ctx)?.id;

		// Cheap pre-filter: explicit BLOCKED/DONE needs no model call. In dry-run this
		// is still reported, otherwise silence is ambiguous — did it decide, or not run?
		const quick = analyzeTurnEnd(text);
		if (quick.verdict !== "continue") {
			if (state.dryRun) {
				pi.appendEntry(DECISION_ENTRY_TYPE, {
					dry: true,
					sent: false,
					action: "skip",
					reply: "",
					reason: `agent declared ${quick.verdict.toUpperCase()} — no model call`,
					input: preview(text),
					model,
					ms: 0,
					detail: quick.tail,
				} satisfies DecisionEntry);
			}
			return;
		}

		const startedAt = Date.now();
		const { decision, raw } = await askVirtualUser(ctx, text);
		const ms = Date.now() - startedAt;
		const entry: Omit<DecisionEntry, "sent" | "dry"> = {
			action: decision.action === "continue" && decision.reply ? "continue" : "stop",
			reply: decision.reply,
			reason: decision.reason,
			input: preview(text),
			raw: raw.slice(0, 600),
			model,
			ms,
		};

		if (decision.action !== "continue" || !decision.reply) {
			pi.appendEntry(DECISION_ENTRY_TYPE, { ...entry, dry: state.dryRun, sent: false } satisfies DecisionEntry);
			stop(`stop: ${decision.reason || "nothing to add"}`, ctx);
			return;
		}

		if (state.dryRun) {
			pi.appendEntry(DECISION_ENTRY_TYPE, { ...entry, dry: true, sent: false } satisfies DecisionEntry);
			// The entry is the durable record; this is so a decision is never
			// invisible just because the transcript scrolled or the renderer is
			// unavailable.
			ctx.ui.notify(`momentum[dry] would send "${decision.reply}"`, "info");
			return;
		}

		state.continues += 1;
		state.lastSentReply = decision.reply;
		refreshStatus(state, ctx);

		// Written before the message so the corpus extractor can tell this user
		// message from a human one.
		pi.appendEntry(DECISION_ENTRY_TYPE, { ...entry, dry: false, sent: true } satisfies DecisionEntry);
		pi.sendUserMessage(decision.reply);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.config = loadConfig(ctx.cwd);
		refreshStatus(state, ctx);
		const local = state.config.layers.filter((layer) => !layer.global);
		ctx.ui.notify(
			`pi-momentum ${state.mode}${state.dryRun ? " (dry-run)" : ""} · ${state.config.never.length} user never-rules ` +
				`+ ${DEFAULT_NEVER.length} built-in from ${local.length} local layer${local.length === 1 ? "" : "s"}. Markers: ${BLOCK_MARKER} / ${DONE_MARKER}`,
			"info",
		);
	});
}
