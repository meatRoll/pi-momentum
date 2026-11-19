# Design

## The problem, measured

Evidence: a 279-turn reverse-engineering session, scored with the tooling in `scripts/`. The transcript itself is private and is not in this repository. `fixtures/corpus/sample.json` is a synthetic corpus that exercises the same code path.

A **turn end** is the last assistant text message before the next user message — the exact moment where an agent run goes idle and the user has to type something.

```
turns                                     279
ended with a question aimed at the user   148  (53%)
  ...of which the reply was ≤12 chars     108  (73% of questions)
reply was ≤12 chars, any turn end         197  (71%)
"继续" as the entire reply                 79
```

Distribution of the one-word replies:

```
79  继续        4  可以，继续      2  B
15  可以        3  继续做          2  开始
 7  做吧        2  那继续          2  接着做
 6  做          2  按你说的做
```

So roughly three quarters of the human input on this session carried no information. The user was not steering; they were unblocking a gate that should not have been closed.

### The rule did not survive the prompt

At entry 15774 the user said, explicitly:

> 不用，把todos调整下，如果不会出现爆盘之类的严重问题，你可以直接执行完，不用询问我。

After that point: **73 of 92 remaining turns still ended with a question.**

This is the reason the plugin is not a skill or a prompt template. An instruction the user typed can be restated by the user; it cannot bind the loop. The binding has to come from `agent_before_settle`, which is the last place Pi lets an extension decide whether the run continues.

## Deriving the rule

Sorting the 148 question-endings by what the agent actually knew when it asked:

**A. It already had a next step.** The overwhelming majority. The message names the step, then asks permission for it.

```
要我接着做这个吗？                        ← 提交 2a44e0a 之后
继续解 0x45a4 吗？                        ← 继续解
要我继续补采样吗？                        ← 继续
```

**B. It had a recommendation and still asked.** Fewer, but worse — the recommendation was already the decision.

```
我建议 A（一次性成本，后面都省）。要装吗？
我倾向 (b) 先拿可交付成果，(a) 并行推进。你怎么看？
```

One message in the session got this right unprompted, which is the pattern the contract formalizes:

```
你选哪条？回一句"A"或"B"我就开工；不回复的话我按 C→A 推进。
```

**C. Genuinely blocked.** Four shapes only:

| shape | example |
|---|---|
| irreversible / destructive | 清掉 470MB 中间产物；装 Ghidra；"发这一枪" |
| external side effect | 真实请求、真机抓包、对外发布 |
| information only the user holds | "有没有哪个接口是不需要签名那批覆盖不到的" |
| the goal is ambiguous | "我想做成 app，安卓和 iOS 呢" |

**D. Not a decision at all — a reporting failure.** Many "substantive" replies were the user asking *why*, not answering:

```
为什么 digest 那么麻烦？
这个任务太久了，究竟在干啥
为啥还要启动模拟器
```

That is a progress-reporting problem, not a gate problem. Out of scope here, but worth noting: a better status line would have prevented a slice of these.

## Rule

> Continue whenever a recommendation exists. Stop only on an explicit declaration, and only for the four categories above.

Encoded as a two-marker protocol, because anything softer cannot be checked mechanically:

- `⏸ BLOCKED` — must be followed by the decision point, ≥2 candidates, the recommendation, and why the recommendation is not enough.
- `✓ DONE` — the work is finished.
- neither → continue.

Markers must open a line. This matters: a first pass matched `\bBLOCKED\b` anywhere and fired on *"3. 主线 #61 标 `blocked`"* — a todo status, not a declaration. Scoping the regex to line starts fixed it.

## Error costs

The design is asymmetric on purpose.

| error | consequence |
|---|---|
| continue when it should have stopped | one wasted round; the agent restates the block in the required format and then stops |
| stop when it should have continued | the exact friction this plugin exists to remove |

So the detector defaults to continue. The cap (`maxContinues`, default 3) bounds the cost of the first error.

## Implementation

`agent_before_settle` returns:

```ts
{
  entries: [...event.entries, { type: "custom_message", customType: "pi-momentum/continue", content: nudge, display: false }],
  continue: true,
}
```

`continue: true` requests exactly one more provider request. Guards:

- `event.outcome === "completed"` — never resurrect an aborted or errored run
- `event.context.canContinue`
- `state.continues < state.maxContinues`
- the analysis verdict is `continue`
- the last assistant message exists and is non-empty

The counter resets on the `input` event with `source === "interactive"` — a real human prompt. Our own `sendUserMessage` arrives with `source === "extension"`, so it does not clear the cap and cannot loop forever.

## Virtual-user mode

`nudge` tells the agent to keep going. `virtual` **speaks for the user**, which is a different risk, so three things flip:

| | nudge | virtual |
|---|---|---|
| hook | `agent_before_settle` + `continue: true` | `agent_settled` + `pi.sendUserMessage()` |
| message identity | `custom_message` (extension-authored) | real user message |
| default | continue | **stop** |
| context seen | the run | **only the last assistant message** |
| cost | free | one one-shot model call |

`agent_settled` is forced by the requirement that the reply look like the user typed it: `sendUserMessage` needs an idle session. The upside is that the decision is no longer made inside the run that is asking the question — which is also why the model gets only the last message, not the transcript. An intent reader with one message of context cannot start pursuing its own goals.

The default flips to `stop` for the same reason. In nudge mode a wrong "continue" costs a round; here it writes a request into the transcript that the user never made. Everything unusable — bad JSON, a rejected reply, a failed call — degrades to silence.

The never-list is a user-authored prefix plus a regex backstop, because substring matching does not survive paraphrase: `安装新软件或依赖` does not match `装一下新软件`. Built-in patterns cover the five categories; user entries are matched literally.

## Open questions

1. **Does the contract hold on models that ignore system-prompt rules?** The gate fires regardless, so the loop is enforced, but a model that never prints the markers will burn the cap every turn.
2. **`DONE` is the weak marker.** Agents are bad at knowing when they are finished, and the gate pushes against stopping. A stricter definition ("no remaining todos and no uncommitted changes") may be needed.
3. **Reporting quality is a separate axis.** Half of category D is the agent not saying what it is doing; better progress reporting would reduce redundant questions more than any gate.
4. **Per-category caps.** Destructive actions warrant a hard stop even without a marker; that belongs in a permission extension, not here.
