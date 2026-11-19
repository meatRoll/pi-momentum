/**
 * Turn-end analysis for pi-momentum.
 *
 * Pure functions with no Pi imports: the extension, the offline corpus tools,
 * and the tests all share this module.
 *
 * The rule this module encodes:
 *
 *   An agent may keep running whenever it can name a recommendation.
 *   It may stop only by saying so explicitly (BLOCKED) or by declaring the work
 *   finished (DONE). Everything else is treated as "keep going".
 *
 * That default is deliberate. Measured on a 278-turn research session, 53% of
 * turns ended in a question and 73% of those got a one-word "continue" back.
 * Asking is the failure mode, not the safe default.
 */

export type Verdict = "continue" | "blocked" | "done";

export interface TurnEndAnalysis {
	verdict: Verdict;
	/** Assistant text ended with a question aimed at the user. */
	endsWithQuestion: boolean;
	/** Explicit escape hatch: the agent says it cannot decide. */
	hasBlockMarker: boolean;
	/** The agent declares the task finished. */
	hasDoneMarker: boolean;
	/** The tail names a next step / recommendation. */
	hasRecommendation: boolean;
	/** Last meaningful line, collapsed — for logs and corpus review. */
	tail: string;
	/** Human-readable justification for the verdict. */
	reason: string;
}

/** Marker an agent must print to be allowed to stop and wait for the user. */
export const BLOCK_MARKER = "⏸ BLOCKED";

/** Marker an agent may print when the task is actually finished. */
export const DONE_MARKER = "✓ DONE";

// Markers must be *declared*: the token has to open a line. A bare mention
// mid-sentence ("mark the ticket `blocked`") is not a declaration, and loose
// Chinese phrases like 已完成 fire on ordinary status reports.
const BLOCK_RE = /^[\s>*_-]*(?:⏸\ufe0f?\s*)?BLOCKED\b/im;
const DONE_RE = /^[\s>*_-]*(?:✓\s*)?DONE\b/im;

/** Phrases that mean "I already know what to do next". */
const RECOMMENDATION_MARKERS = [
	"我建议",
	"建议",
	"我倾向",
	"倾向",
	"推荐",
	"下一步",
	"接下来",
	"我打算",
	"计划",
	"先做",
	"先跑",
	"先攻",
	"i recommend",
	"i suggest",
	"i'll ",
	"next step",
	"my plan",
];

/**
 * Split text into meaningful lines, dropping blank lines and code-fence bodies.
 * A question inside a fenced block is not a question for the user.
 */
export function meaningfulLines(text: string): string[] {
	const out: string[] = [];
	let inFence = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !line) continue;
		out.push(line);
	}
	return out;
}

/** Last meaningful line, whitespace-collapsed. */
export function tailLine(text: string): string {
	const lines = meaningfulLines(text);
	return (lines.at(-1) ?? "").replace(/\s+/g, " ").trim();
}

/** Join the trailing `count` meaningful lines, for phrasing detection. */
export function tailWindow(text: string, count = 3): string {
	return meaningfulLines(text).slice(-count).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Does the message end by asking the user something?
 * Checks the last meaningful line first, then the trailing window, because a
 * question can be followed by a short colon-introduction line.
 */
export function endsWithQuestion(text: string): boolean {
	const last = tailLine(text);
	if (/[?？]/.test(last)) return true;
	const window = tailWindow(text, 2);
	return /[?？]\s*$/.test(window);
}

export function hasRecommendation(text: string): boolean {
	const window = tailWindow(text, 6).toLowerCase();
	return RECOMMENDATION_MARKERS.some((marker) => window.includes(marker.toLowerCase()));
}

/** Analyze one assistant message that ended a run. */
export function analyzeTurnEnd(text: string): TurnEndAnalysis {
	const trimmed = text.trim();
	const tail = tailLine(trimmed);

	// Scan the whole message: a declaration may follow a summary block.
	const hasBlockMarker = BLOCK_RE.test(trimmed);
	const hasDoneMarker = !hasBlockMarker && DONE_RE.test(trimmed);
	const question = endsWithQuestion(trimmed);
	const recommendation = hasRecommendation(trimmed);

	if (hasBlockMarker) {
		return {
			verdict: "blocked",
			endsWithQuestion: question,
			hasBlockMarker,
			hasDoneMarker: false,
			hasRecommendation: recommendation,
			tail,
			reason: "agent declared BLOCKED",
		};
	}

	if (hasDoneMarker) {
		return {
			verdict: "done",
			endsWithQuestion: question,
			hasBlockMarker: false,
			hasDoneMarker,
			hasRecommendation: recommendation,
			tail,
			reason: "agent declared DONE",
		};
	}

	return {
		verdict: "continue",
		endsWithQuestion: question,
		hasBlockMarker: false,
		hasDoneMarker: false,
		hasRecommendation: recommendation,
		tail,
		reason: question
			? recommendation
				? "ended with a question although a recommendation was stated"
				: "ended with a question"
			: recommendation
				? "stated a next step without executing it"
				: "stopped with no explicit BLOCKED or DONE marker",
	};
}

/**
 * The nudge injected when the agent stopped without a BLOCKED/DONE marker.
 * Kept short: it is appended to the transcript on every continuation.
 */
export function continuationPrompt(analysis: TurnEndAnalysis): string {
	const lines = [
		"Momentum: 你停下来了，但没有声明 ⏸ BLOCKED 或 ✓ DONE，因此这一轮不成立。",
		"",
	];
	if (analysis.hasRecommendation) {
		lines.push("你已经给出推荐方案。按它直接执行，不要再确认。");
	} else if (analysis.endsWithQuestion) {
		lines.push("如果你其实已经知道下一步做什么：直接做，不要问。");
	} else {
		lines.push("先说清下一步是什么，然后立刻开始执行。");
	}
	lines.push(
		"",
		"只有下面四类情况才允许你停下并等待用户：",
		"1. 不可逆或破坏性操作（删除数据、重装系统级软件、改写远程历史）",
		"2. 外部副作用或花钱（对外发布、真实请求、付费接口）",
		"3. 只有用户掌握的偏好、优先级或私有信息",
		"4. 目标本身有歧义（不是方案没定）",
		"",
		"命中上述任一类：输出 ⏸ BLOCKED，然后写清卡点、候选方案、你的推荐、以及为什么不够格自决。",
		"任务真的做完：输出 ✓ DONE 加一句结论。",
	);
	return lines.join("\n");
}
