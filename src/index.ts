/**
 * pi-momentum — a turn-end gate for Pi.
 *
 *   on    when a run goes idle, read the agent's last message; if it is waiting
 *         on the user, inject the one-line reply a user would send
 *   off   do nothing
 *   test  run the same decision on demand, and send nothing
 *
 * Both the live gate and `test` stop when the agent declares `⏸ BLOCKED` or
 * `✓ DONE` — those are explicit, readable statements and cost no model call.
 *
 * Load with:  pi -e ./src/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	addNever,
	listDirectories,
	legacyConfigPath,
	loadConfig,
	type MomentumConfig,
	type NeverRule,
	removeNever,
} from "./config.ts";
import { analyzeTurnEnd, BLOCK_MARKER, DONE_MARKER } from "./detect.ts";
import { RULES, SECTION_TAG } from "./rules.ts";
import {
	buildSystemPrompt,
	DEFAULT_NEVER,
	type Decision,
	parseDecision,
	parseRuleResponse,
	RULE_PROMPT,
} from "./virtual.ts";
import { VERSION } from "./version.ts";

/** Every decision, rendered in the transcript, never sent to the model. */
const DECISION_ENTRY_TYPE = "pi-momentum/decision";
const MAX_DEFAULT = 3;

const SUBCOMMANDS = [
	{ value: "on", label: "on", description: "reply for you when the agent stops and is waiting" },
	{ value: "off", label: "off", description: "do nothing" },
	{ value: "test", label: "test", description: "simulate the reply for the last message; send nothing" },
	{ value: "never", label: "never", description: "rules the reply must never contain (list | add | rm)" },
	{ value: "dirs", label: "dirs", description: "directories with their own rules" },
	{ value: "max", label: "max", description: "cap automatic replies per user turn (off = no cap)" },
	{ value: "prompt", label: "prompt", description: "print the virtual-user system prompt" },
	{ value: "status", label: "status", description: "mode, version, rules" },
];

const NEVER_SUBCOMMANDS = [
	{ value: "list", label: "list", description: "show rules with their scope" },
	{ value: "add", label: "add", description: "append a rule (--global for every directory)" },
	{ value: "rm", label: "rm", description: "pick a rule to remove (or pass its text)" },
];

interface DecisionEntry {
	sent: boolean;
	action: "continue" | "stop";
	reply: string;
	reason: string;
	/** The assistant text the decision was made on. */
	input: string;
	raw?: string;
	model?: string;
	ms: number;
}

interface MomentumState {
	on: boolean;
	maxContinues: number;
	/** Replies injected in the current user turn. */
	continues: number;
	config: MomentumConfig;
}

function preview(text: string, limit = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

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

/** Last assistant text on the current branch. */
function lastAssistantText(ctx: ExtensionContext): string {
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

/** Labels a rule for the picker; the scope is what makes two similar rules distinguishable. */
function ruleLabel(rule: NeverRule): string {
	return `[${rule.scope}] ${rule.text}` + (rule.terms?.length ? `  · ${rule.terms.join(", ")}` : "");
}

/** Ask which rule to drop. Returns the stored text, or undefined when cancelled. */
async function pickRule(ctx: ExtensionContext, config: MomentumConfig): Promise<string | undefined> {
	if (config.rules.length === 0) {
		ctx.ui.notify("momentum: no rules to remove — built-in defaults are not listed here", "info");
		return undefined;
	}
	const labels = config.rules.map(ruleLabel);
	const picked = await ctx.ui.select(`Remove a never-rule (${config.rules.length})`, labels);
	if (!picked) return undefined;
	const index = labels.indexOf(picked);
	return index >= 0 ? config.rules[index]?.text : undefined;
}

/** `off` lifts the cap; a plain number sets it; anything else is a usage error. */
function parseMaxArg(value: string): number | undefined {
	if (/^(off|unlimited|inf|∞)$/i.test(value)) return Infinity;
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function formatMax(max: number): string {
	return Number.isFinite(max) ? String(max) : "∞";
}

function refreshStatus(state: MomentumState, ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		"momentum",
		state.on ? `⚡ ${state.continues}/${formatMax(state.maxContinues)}` : undefined,
	);
}

export default async function momentumExtension(pi: ExtensionAPI): Promise<void> {
	// Only available inside Pi. Offline tests must not need it, and the renderer
	// is a convenience: the extension works without one.
	const tui = (await import("@earendil-works/pi-tui").catch(() => undefined)) as
		| { Box: new (...args: never[]) => unknown; Text: new (...args: never[]) => unknown }
		| undefined;

	const state: MomentumState = { on: false, maxContinues: MAX_DEFAULT, continues: 0, config: { never: [] } };

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
	 * One isolated call: the system prompt is the intent reader, the single user
	 * message is the agent's last words. Nothing else of the conversation reaches
	 * the decision, so it cannot inherit the question it is answering.
	 */
	/**
	 * One isolated call. `hint` is what the mechanical detector already knows —
	 * it goes in the user message so the model does not have to rediscover that
	 * the turn stated a next step, and can concentrate on whether to speak.
	 */
	async function askVirtualUser(
		ctx: ExtensionContext,
		text: string,
		hint?: string,
	): Promise<{ decision: Decision; raw: string }> {
		const model = resolveModel(ctx);
		if (!model) return { decision: { action: "stop", reply: "", reason: "no model available" }, raw: "" };

		let raw = "";
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: buildSystemPrompt(state.config.never),
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: hint ? `${text}\n\n<turnsignal>${hint}</turnsignal>` : text,
								},
							],
							timestamp: Date.now(),
						},
					],
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
		return { decision: parseDecision(raw, state.config.rules), raw };
	}

	/**
	 * Turn what the user typed into a rule plus match terms. The heuristic in
	 * virtual.ts covers the shapes we anticipated; this covers the rest, and the
	 * fallback is the raw text so a failed call never loses the rule.
	 */
	async function normaliseRule(ctx: ExtensionContext, text: string) {
		const model = resolveModel(ctx);
		if (!model) return { text };
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: RULE_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
				} as never,
				{},
			);
			if (response.stopReason === "aborted" || response.stopReason === "error") return { text };
			return parseRuleResponse(textOf(response.content), text);
		} catch {
			return { text };
		}
	}

	if (tui) {
		pi.registerEntryRenderer<DecisionEntry>(DECISION_ENTRY_TYPE, (entry, { expanded }, theme) => {
			const data = entry.data;
			const { Box, Text } = tui as never as Record<string, never> as {
				Box: new (a: number, b: number, c: (t: string) => string) => { addChild: (n: unknown) => void };
				Text: new (t: string, a?: number, b?: number) => unknown;
			};
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			const status = data.sent ? theme.fg("success", "sent") : theme.fg("dim", "stopped");
			const head =
				data.action === "continue"
					? `${theme.bold(theme.fg("accent", "momentum"))} ${status} → ${theme.bold(`“${data.reply}”`)}`
					: `${theme.bold(theme.fg("accent", "momentum"))} ${status}`;
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
				if (data.raw) box.addChild(new Text(theme.fg("muted", `raw: ${data.raw}`), 0, 0));
			}
			return box;
		});
	}

	pi.registerFlag("momentum", {
		description: "pi-momentum: reply for the user when the agent stops and is waiting",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("momentum", {
		description: "pi-momentum: on | off | test [text] | never list|add|rm | max <n> | prompt",
		handler: async (args, ctx) => {
			const [verb = "status", ...rest] = args.trim().split(/\s+/);
			const value = rest.join(" ").trim();

			switch (verb) {
				case "on":
					state.on = true;
					state.continues = 0;
					break;
				case "off":
					state.on = false;
					break;
				case "max": {
					const parsed = parseMaxArg(value);
					if (parsed === undefined) {
						ctx.ui.notify("Usage: /momentum max <n> | off", "warning");
						return;
					}
					state.maxContinues = parsed;
					break;
				}
				case "test": {
					// No argument: simulate the reply for the conversation as it stands.
					const explicit = rest.join(" ").trim();
					const text = explicit || lastAssistantText(ctx);
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
					const { decision, raw } = await askVirtualUser(ctx, text, quick.reason);
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
					return;
				}
				case "prompt": {
					ctx.ui.notify(buildSystemPrompt(state.config.never), "info");
					return;
				}
				case "never": {
					const [action = "list", ...words] = rest;
					const scope = words.includes("--global") ? "global" : "dir";
					const entry = words.filter((word) => !word.startsWith("--")).join(" ").trim();

					if (action === "add" && entry) {
						const rule = words.includes("--raw") ? { text: entry } : await normaliseRule(ctx, entry);
						addNever(state.config, rule, scope);
						state.config = loadConfig(ctx.cwd);
						ctx.ui.notify(
							`momentum: wrote ${state.config.storePath} [${scope === "global" ? "global" : state.config.dirKey}]\n` +
								`  rule:  ${rule.text}` +
								(rule.terms?.length ? `\n  terms: ${rule.terms.join(" · ")}` : ""),
							"info",
						);
					} else if (action === "rm") {
						// Typing the stored sentence back is the hard part, so no argument
						// means pick it from a list.
						const target = entry || (await pickRule(ctx, state.config));
						if (!target) return;
						if (!removeNever(state.config, target)) {
							ctx.ui.notify(`Not in the list: ${target}`, "warning");
							return;
						}
						state.config = loadConfig(ctx.cwd);
						ctx.ui.notify(`momentum: removed "${target}"`, "info");
					}

					const lines = state.config.rules.map(
						(rule) =>
							`  [${rule.scope}] ${rule.text}` +
							(rule.terms?.length ? `\n      ↳ ${rule.terms.join(" · ")}` : ""),
					);
					ctx.ui.notify(
						`momentum never-rules — dir ${state.config.dirKey}` +
							`${state.config.replace ? " (directory rules replace global)" : ""}:\n` +
							(lines.length > 0 ? lines.join("\n") : "  (none — built-in defaults still apply)"),
						"info",
					);
					return;
				}
				case "dirs": {
					const dirs = listDirectories(state.config);
					ctx.ui.notify(
						`momentum directories (${dirs.length}) — ${state.config.storePath}\n` +
							(dirs.length > 0
								? dirs.map((dir) => `  ${dir.key}  (${dir.rules} rules)`).join("\n")
								: "  (none)"),
						"info",
					);
					return;
				}
				default:
					break;
			}

			refreshStatus(state, ctx);
			ctx.ui.notify(
				`momentum v${VERSION}: ${state.on ? "on" : "off"} · max ${formatMax(state.maxContinues)} · ` +
					(state.config.never.length === 0
						? `no never-rules set (${DEFAULT_NEVER.length} built-in still active)`
						: `${state.config.never.length} never-rules + ${DEFAULT_NEVER.length} built-in`),
				"info",
			);
		},
	});

	// A real human prompt is the only thing that resets the cap. Our own injected
	// message arrives with source "extension", so it does not clear the counter.
	pi.on("input", async (event) => {
		if (event.source === "interactive") state.continues = 0;
	});

	// The contract. An agent that declares BLOCKED/DONE skips the model call
	// entirely, so this text pays for itself.
	pi.on("before_agent_start", async (event) => {
		if (!state.on) return;
		const options = event.systemPromptOptions;
		if (options?.sections) {
			options.sections[SECTION_TAG] = RULES;
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${RULES}` };
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!state.on || event.aborted) return;
		if (!ctx.isIdle()) return;
		if (state.continues >= state.maxContinues) {
			ctx.ui.setStatus("momentum", "⚡ capped");
			return;
		}

		const text = lastAssistantText(ctx);
		if (!text.trim()) return;

		// Cheap pre-filter: an explicit BLOCKED/DONE needs no model call. Nothing is
		// logged here — nothing happened, and logging it would be noise on every
		// finished turn.
		if (analyzeTurnEnd(text).verdict !== "continue") return;

		const analysis = analyzeTurnEnd(text);
		const startedAt = Date.now();
		const { decision, raw } = await askVirtualUser(ctx, text, analysis.reason);
		const ms = Date.now() - startedAt;
		const base = {
			reply: decision.reply,
			reason: decision.reason,
			input: preview(text),
			raw: raw.slice(0, 600),
			model: ctx.model?.id,
			ms,
		};

		if (decision.action !== "continue" || !decision.reply) {
			pi.appendEntry(DECISION_ENTRY_TYPE, { ...base, action: "stop", sent: false } satisfies DecisionEntry);
			ctx.ui.setStatus("momentum", `⚡ stop`);
			return;
		}

		state.continues += 1;
		refreshStatus(state, ctx);

		// Written before the message so the corpus extractor can tell this user
		// message from a human one.
		pi.appendEntry(DECISION_ENTRY_TYPE, { ...base, action: "continue", sent: true } satisfies DecisionEntry);
		pi.sendUserMessage(decision.reply);
	});

	// Argument completion for `/momentum `. Without it the command is a list of
	// subcommands you have to remember.
	pi.on("session_start", async (_event, ctx) => {
		state.config = loadConfig(ctx.cwd);
		// The file is the only way to make a limit survive a restart.
		state.maxContinues = state.config.maxContinues ?? MAX_DEFAULT;
		refreshStatus(state, ctx);

		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: [" "],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);

				const neverFlag = before.match(/^\s*\/momentum\s+never\s+add\s+(--\S*)$/);
				if (neverFlag) {
					const prefix = neverFlag[1] ?? "";
					return { prefix, items: NEVER_FLAGS.filter((item) => item.value.startsWith(prefix)) };
				}

				const neverMatch = before.match(/^\s*\/momentum\s+never\s+(\S*)$/);
				if (neverMatch) {
					const prefix = neverMatch[1] ?? "";
					return { prefix, items: NEVER_SUBCOMMANDS.filter((item) => item.value.startsWith(prefix)) };
				}

				const maxMatch = before.match(/^\s*\/momentum\s+max\s+(\S*)$/);
				if (maxMatch) {
					const prefix = maxMatch[1] ?? "";
					return { prefix, items: MAX_OPTIONS.filter((item) => item.value.startsWith(prefix)) };
				}

				const argMatch = before.match(/^\s*\/momentum\s+(\S*)$/);
				if (!argMatch) return current.getSuggestions(lines, cursorLine, cursorCol, options);

				const prefix = argMatch[1] ?? "";
				return { prefix, items: SUBCOMMANDS.filter((item) => item.value.startsWith(prefix)) };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}

const NEVER_FLAGS = [
	{ value: "--global", label: "--global", description: "apply to every directory" },
	{ value: "--raw", label: "--raw", description: "store the sentence as typed, skip normalisation" },
];

const MAX_OPTIONS = [
	...["1", "2", "3", "5", "10"].map((value) => ({
		value,
		label: value,
		description: "automatic replies per user turn",
	})),
	{ value: "off", label: "off", description: "no cap" },
];
