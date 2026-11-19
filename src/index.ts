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
import { addNever, loadConfig, type MomentumConfig, type NeverScope, removeNever } from "./config.ts";
import { analyzeTurnEnd, BLOCK_MARKER, continuationPrompt, DONE_MARKER } from "./detect.ts";
import { RULES, SECTION_TAG } from "./rules.ts";
import { buildSystemPrompt, type Decision, parseDecision } from "./virtual.ts";

const CONTINUE_CUSTOM_TYPE = "pi-momentum/continue";
const VIRTUAL_ENTRY_TYPE = "pi-momentum/virtual-reply";
const MAX_DEFAULT = 3;

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

export default function momentumExtension(pi: ExtensionAPI): void {
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
	async function askVirtualUser(ctx: ExtensionContext, text: string): Promise<Decision> {
		const model = resolveModel(ctx);
		if (!model) return { action: "stop", reply: "", reason: "no model available" };

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
				return { action: "stop", reply: "", reason: `model ${response.stopReason}` };
			}
			raw = textOf(response.content);
		} catch (error) {
			return { action: "stop", reply: "", reason: `call failed: ${String(error)}` };
		}
		return parseDecision(raw, state.config.never);
	}

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
				case "never": {
					const [action = "list", ...words] = rest;
					const scopeFlag = words.includes("--global") ? "global" : words.includes("--repo") ? "repo" : undefined;
					const entry = words
						.filter((word) => !word.startsWith("--"))
						.join(" ")
						.trim();

					if (action === "add" && entry) {
						const path = addNever(state.config, entry, scopeFlag ?? "repo");
						if (!path) {
							ctx.ui.notify("No repository found; use --global to add it for every project", "warning");
							return;
						}
					} else if (action === "rm" && entry) {
						// Remove from the scope that actually declares it.
						const declared = state.config.rules.find((rule) => rule.text === entry);
						if (!declared) {
							ctx.ui.notify(`Not in the list: ${entry}`, "warning");
							return;
						}
						removeNever(state.config, entry, scopeFlag ?? declared.scope);
					}

					state.config = loadConfig(ctx.cwd);
					const where = state.config.repoRoot ?? "no repository";
					const lines = state.config.rules.map(
						(rule) => `  [${rule.scope}] ${rule.text}`,
					);
					ctx.ui.notify(
						`momentum never-rules (${where}${state.config.replace ? ", global list replaced" : ""}):\n` +
							(lines.length > 0 ? lines.join("\n") : "  (none — built-in defaults still apply)"),
						"info",
					);
					break;
				}
				default:
					break;
			}
			refreshStatus(state, ctx);
			ctx.ui.notify(
				`momentum: ${state.mode}${state.dryRun ? " (dry-run)" : ""} · max ${state.maxContinues} · ${state.config.never.length} never-rules`,
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

		// Cheap pre-filter: explicit BLOCKED/DONE needs no model call.
		const quick = analyzeTurnEnd(text);
		if (quick.verdict !== "continue") return;

		const decision = await askVirtualUser(ctx, text);

		if (decision.action !== "continue" || !decision.reply) {
			stop(`stop: ${decision.reason || "nothing to add"}`, ctx);
			return;
		}

		if (state.dryRun) {
			ctx.ui.notify(`momentum[dry]: would reply "${decision.reply}"`, "info");
			return;
		}

		state.continues += 1;
		state.lastSentReply = decision.reply;
		refreshStatus(state, ctx);

		// Audit trail: the transcript must stay able to tell a human from us.
		pi.appendEntry(VIRTUAL_ENTRY_TYPE, {
			reply: decision.reply,
			reason: decision.reason,
			model: ctx.model?.id,
			at: Date.now(),
		});

		pi.sendUserMessage(decision.reply);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.config = loadConfig(ctx.cwd);
		refreshStatus(state, ctx);
		const repo = state.config.repoRoot;
		ctx.ui.notify(
			`pi-momentum ${state.mode}${state.dryRun ? " (dry-run)" : ""} · ${state.config.never.length} never-rules` +
				`${repo ? ` (${repo.split("/").pop()})` : " (no repo)"}. Markers: ${BLOCK_MARKER} / ${DONE_MARKER}`,
			"info",
		);
	});
}
