# Testing pi-momentum

The gate changes model behaviour, so most of what can go wrong is behavioural,
not a crash. Test in this order: cheap and deterministic first, real usage last.

## 0. Load check

Restart Pi, then:

```
/momentum
```

Expect a notify like `momentum: off (dry-run) · max 3 · N never-rules` and an
`⚡` absence while off. If nothing appears, run `pi-manager doctor --json` and
check the snapshot is published.

```
/momentum prompt
```

Prints the exact system prompt. **Read it.** The never-list should be in it; if
a rule you added is missing, the layer is wrong (section 3).

## 1. Offline

```bash
npm test        # 15 virtual + 15 config + 9 smoke + 6 detector
npm run analyze
```

Offline tests cover parsing, guardrails, layer folding and the gate wiring. They
say nothing about whether the generated reply is any good — that is the whole
point of the rest.

## 2. Layer check

Put rules at two levels and confirm the fold:

```bash
# from the repo root
/momentum never add 不要碰 vendor/
# from a package inside it
cd packages/foo
/momentum never add 不许改迁移
/momentum never list
```

Expect both rules, the second labelled with the deeper layer. Then from
`packages/foo/src`, the same two should still appear.

## 3. Decision cases

`/momentum test <text>` runs the virtual-user call on arbitrary text and prints
the decision **without sending anything**. This is the cheapest way to probe the
prompt, and it needs no session state.

| input | expect |
|---|---|
| `要我接着做这个吗？` | `continue` |
| `我建议先做 A，再做 B。要继续吗？` | `continue`, reply takes A |
| `两条路：A 改配置 / B 重构。你选哪条？` (no recommendation) | `continue`, smallest reversible step |
| `⏸ BLOCKED … 需要你确认删除` | `stop`, **0 model calls** |
| `✓ DONE 全部完成` | `stop`, **0 model calls** |
| `190 测试绿，工作区干净。` | `continue` (status without a next step) |
| `你希望界面偏哪种风格？` (only the user knows) | `stop` |
| `要我重装一下依赖包吗？` | `stop` (guardrail) |

The last two matter most: they are the failures that write something into the
transcript the user never said.

## 4. End to end

```
/momentum virtual
/momentum dry          # first pass: observe only
```

Work normally. Every stop prints `momentum[dry]: would reply "…"`. Collect
around ten before turning sending on, and judge the replies, not the verdicts.

```
/momentum send
```

Now check the guardrails:

- **Cap** — keep the agent spinning; after `max` continuations the footer shows
  `⚡ capped` and control returns.
- **Reset** — type anything yourself; the counter goes back to `0/N`.
- **Audit** — each injected reply writes a `pi-momentum/virtual-reply` entry.
  `npm run corpus -- <session>` should tag those turns; `npm run analyze` should
  exclude them and print `(N excluded: replies injected by pi-momentum)`.

## 5. Failure modes to watch for

| symptom | likely cause |
|---|---|
| reply is a question | model ignored the rule; `sanitizeReply` allows questions only if it strips them, check `raw` via `/momentum test` |
| reply picks an option the agent did not recommend | prompt step 3, needs a sharper instruction |
| reply in the wrong language | prompt does not pin the language yet — worth adding |
| everything stops | `never` too broad, or the agent always declares `BLOCKED` |
| `capped` every turn | the agent never declares `DONE`; that is the known weak marker |
| zero model calls when it should decide | `analyzeTurnEnd` matched `BLOCKED`/`DONE` — it only matches at line start |

## 6. What to measure

Per session, once there is real usage:

- **accepted** — the agent continued and you did not intervene
- **wrong turn** — you aborted or corrected within a turn
- **silent stops** — how often it chose `stop`, and whether that was right
- **cost** — one extra completion per stop; watch the cheap-model setting
- **latency** — the delay between the agent stopping and the next turn starting

A wrong turn is the expensive error. If it exceeds roughly one in ten, tighten
the prompt before widening the cap.
