/**
 * Virtual-user mode.
 *
 * When a run goes idle, one isolated one-shot model call reads the *last
 * assistant message only* and decides whether that text is waiting on the user.
 * If it is, the call also produces the one-line reply a user would send back,
 * and the extension injects it as a real user message.
 *
 * Two deliberate asymmetries:
 *
 * - `stop` is the default. This speaks for the user; being wrong means the
 *   transcript contains a request the user never made.
 * - The decision never sees the conversation. It reads one message and infers
 *   intent from that message alone, which is also what bounds its authority.
 */

export interface Decision {
	action: "continue" | "stop";
	/** One-line user-voice reply. Empty when action is "stop". */
	reply: string;
	/** Why the model decided this. Never enters the main context. */
	reason: string;
}

/** Things a virtual user must never authorize, whatever the agent recommends. */
export const DEFAULT_NEVER: readonly string[] = [
	"安装新软件或依赖",
	"删除、清空或覆盖数据",
	"发布、部署或对外推送",
	"修改系统级配置或重装组件",
	"调用付费接口或产生费用",
];

/**
 * The guardrail behind the prompt. Substring matching alone misses paraphrases —
 * "装一下新软件" does not contain "安装新软件或依赖" — so the built-in rules are
 * patterns. This is a backstop, not a guarantee.
 */
const DESTRUCTIVE_VERB = "(删|删除|删掉|清空|清掉|覆盖|移除|抹掉)";
const DESTRUCTIVE_NOUN = "(数据|文件|目录|缓存|产物|分支|库|镜像|仓库|历史)";

const BANNED_PATTERNS: readonly RegExp[] = [
	/装.{0,6}(软件|工具|依赖|包|程序|组件)/,
	/(安装|重装|升级|下载).{0,6}(软件|工具|依赖|包|程序|组件)/,
	// Either order: "清掉产物" and "产物清掉" both mean the same thing.
	new RegExp(`${DESTRUCTIVE_VERB}.{0,8}${DESTRUCTIVE_NOUN}|${DESTRUCTIVE_NOUN}.{0,8}${DESTRUCTIVE_VERB}`),
	/(发布|部署|上线|推送|提交到远|push|merge|合并)/i,
	/(付费|充值|扣费|计费)/,
	/(sudo|rm\s+-rf|drop\s+table|format)/i,
];

export const MAX_REPLY_CHARS = 40;

const NO_REPLY: Decision = { action: "stop", reply: "", reason: "" };

/**
 * The prompt. Note what it does *not* say: there is no "you are a user with
 * opinions". It is an intent reader that then speaks in the user's voice.
 */
export function buildSystemPrompt(never: readonly string[]): string {
	const banned = (never.length > 0 ? never : DEFAULT_NEVER).map((item) => `- ${item}`).join("\n");
	return `你是一个"虚拟用户"回复生成器。

输入：AI 助手对真实用户说的最后一段话。

你的任务是**理解这段话的意思**，然后顺着它的意思说一句用户会说的话。你不是一个有自己想法的用户，你只是替真人点头。

判断步骤：
1. 读这段话在等什么。可能是：等确认、多选一、提问、宣布完成、报告阻塞、等用户提供只有他知道的信息。
2. 只有在"确实在等下一步"，并且"下一步能从它自己的话里推出来"时，才继续。
3. 有多个选项时，选它自己推荐的那个（"我建议 / 我倾向 / 推荐 / 建议先…"）。它没给推荐时，选改动最小、最可逆、成本最低的那个。
4. 其余情况一律停止：宣布完成、报告阻塞、在等只有真人才知道的信息、你的推断存在歧义。

下列内容禁止出现在回复里，也禁止作为被选择的选项：
${banned}

回复的硬性要求：
- 一句话，不超过 ${MAX_REPLY_CHARS} 字
- 不引入它没提过的新目标、新事实、新文件、新数字
- 不复述它的结论，不重复它的措辞
- 不以问号结尾
- 不承诺结果、不夸赞

只输出一个 JSON 对象，不要代码块、不要解释：
{"action":"continue","reply":"一句话","reason":"为什么"}

停止时输出：
{"action":"stop","reply":"","reason":"为什么不该继续"}`;
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(raw: string): string | undefined {
	const text = raw.replace(/```(?:json)?/gi, "").trim();
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * Parse a model response into a Decision. Anything unusable degrades to "stop":
 * a malformed answer is not permission to speak for the user.
 */
export function parseDecision(raw: string, never: readonly string[] = []): Decision {
	const json = extractJson(raw);
	if (!json) return { ...NO_REPLY, reason: "unparseable response" };

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return { ...NO_REPLY, reason: "invalid JSON" };
	}

	const action = parsed.action === "continue" ? "continue" : "stop";
	const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
	if (action === "stop") return { action: "stop", reply: "", reason };

	const reply = sanitizeReply(typeof parsed.reply === "string" ? parsed.reply : "", never);
	if (!reply) return { action: "stop", reply: "", reason: reason || "reply rejected by guardrails" };
	return { action: "continue", reply, reason };
}

/**
 * Guardrails on the generated reply. Returns "" when the reply must not be sent.
 * Checked here as well as in the prompt: a model that ignores instructions still
 * must not put a forbidden request into the transcript.
 *
 * `never` entries are treated as literals (what the user wrote); the built-in
 * patterns cover paraphrases of the five default categories.
 */
export function sanitizeReply(reply: string, never: readonly string[] = []): string {
	let text = reply
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!text) return "";
	if (/[?？]/.test(text)) return "";
	if (text.length > MAX_REPLY_CHARS) text = `${text.slice(0, MAX_REPLY_CHARS - 1)}…`;

	for (const pattern of BANNED_PATTERNS) {
		if (pattern.test(text)) return "";
	}

	const haystack = text.toLowerCase();
	for (const item of never) {
		const needle = item.toLowerCase().trim();
		if (needle && haystack.includes(needle)) return "";
	}
	return text;
}
