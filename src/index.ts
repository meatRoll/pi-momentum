/**
 * pi-momentum — a turn-end gate for Pi.
 *
 * Continues the run whenever the agent can name a recommendation, stops only
 * when the agent prints `⏸ BLOCKED` (or `✓ DONE`).
 *
 * Load with:  pi -e ./src/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyzeTurnEnd, BLOCK_MARKER, continuationPrompt, DONE_MARKER } from "./detect.ts";
import { RULES, SECTION_TAG } from "./rules.ts";

const CONTINUE_CUSTOM_TYPE = "pi-momentum/continue";
const MAX_DEFAULT = 3;

interface MomentumState {
	/** Master switch. */
	enabled: boolean;
	/** Detect and report, but never inject a continuation. */
	dryRun: boolean;
	/** Safety valve: max automatic continuations per user turn. */
	maxContinues: number;
	/** Continuations fired in the current user turn. */
	continues: number;
}

const DEFAULT_STATE: MomentumState = {
	enabled: true,
	dryRun: true,
	maxContinues: MAX_DEFAULT,
	continues: 0,
};

/** Extract the text of the last assistant message in a projected message list. */
function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown } | undefined;
		if (!message || message.role !== "assistant") continue;
		const { content } = message;
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
	return "";
}

function statusText(state: MomentumState): string | undefined {
	if (!state.enabled) return undefined;
	const mode = state.dryRun ? "dry" : "enforce";
	return `⚡ momentum ${mode} ${state.continues}/${state.maxContinues}`;
}

function refreshStatus(state: MomentumState, ctx: ExtensionContext): void {
	ctx.ui.setStatus("momentum", statusText(state));
}

export default function momentumExtension(pi: ExtensionAPI): void {
	// Per-instance state: isolated instances keep the smoke test honest.
	const state: MomentumState = { ...DEFAULT_STATE };
	pi.registerFlag("momentum", {
		description: "pi-momentum: continue runs until the agent declares BLOCKED or DONE",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("momentum", {
		description: "Show or change pi-momentum behavior (on|off|enforce|dry|max <n>|status)",
		handler: async (args, ctx) => {
			const [verb = "status", value] = args.trim().split(/\s+/);
			switch (verb) {
				case "on":
					state.enabled = true;
					break;
				case "off":
					state.enabled = false;
					break;
				case "enforce":
					state.enabled = true;
					state.dryRun = false;
					state.continues = 0;
					break;
				case "dry":
					state.enabled = true;
					state.dryRun = true;
					break;
				case "max": {
					const parsed = Number.parseInt(value ?? "", 10);
					if (!Number.isFinite(parsed) || parsed < 0) {
						ctx.ui.notify("Usage: /momentum max <n>", "warning");
						return;
					}
					state.maxContinues = parsed;
					break;
				}
				case "reset":
					state.continues = 0;
					break;
				default:
					break;
			}
			refreshStatus(state, ctx);
			ctx.ui.notify(
				`momentum: ${state.enabled ? "on" : "off"} · ${state.dryRun ? "dry-run" : "enforce"} · max ${state.maxContinues}`,
				"info",
			);
		},
	});

	// Inject the contract and reset the per-turn counter when a real user prompt starts.
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.enabled) return;
		if (event.messageType === "user") state.continues = 0;

		const options = event.systemPromptOptions;
		if (options?.sections) {
			options.sections[SECTION_TAG] = RULES;
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${RULES}` };
	});

	// The gate itself.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (!state.enabled) return;
		if (event.outcome !== "completed") return;
		if (!event.context.canContinue) return;
		if (state.continues >= state.maxContinues) {
			ctx.ui.notify(
				`momentum: hit the ${state.maxContinues}-continuation cap, handing control back`,
				"warning",
			);
			ctx.ui.setStatus("momentum", "⚡ capped");
			return;
		}

		const text = lastAssistantText(event.context.contextMessages);
		if (!text.trim()) return;

		const analysis = analyzeTurnEnd(text);
		if (analysis.verdict !== "continue") return;

		if (state.dryRun) {
			ctx.ui.notify(`momentum[dry]: would continue — ${analysis.reason}`, "info");
			return;
		}

		state.continues += 1;
		refreshStatus(state, ctx);
		ctx.ui.notify(`momentum: continuing (${state.continues}/${state.maxContinues})`, "info");

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

	pi.on("session_start", async (_event, ctx) => {
		refreshStatus(state, ctx);
		ctx.ui.notify(
			`pi-momentum ready (${state.dryRun ? "dry-run" : "enforce"}). Markers: ${BLOCK_MARKER} / ${DONE_MARKER}`,
			"info",
		);
	});
}
