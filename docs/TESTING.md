# Testing pi-momentum

The gate changes model behaviour, so most of what can go wrong is behavioural,
not a crash. Test in this order: cheap and deterministic first, real usage last.

## 0. Load check

Restart Pi, then:

```
/momentum
```

Expect `momentum v<X>: off · max 3 · …`. If the version is missing or older than
the published one, the process is still on an older snapshot: restart it. A
published snapshot never reaches a running process. If nothing appears, run `pi-manager doctor --json` and
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

## 2. Scope check

Two scopes, one file:

```bash
/momentum never add --raw 不要碰 vendor/   # this directory
/momentum never add --raw --global 别删库   # every directory
/momentum never list                        # [dir] then [global], with terms
/momentum never rm                          # picker; cancelling changes nothing
/momentum max off                           # footer shows ⚡ 0/∞
/momentum dirs                              # directories carrying their own rules
```

Rules should appear only in the directory that declared them. `cd` somewhere
else and `list` should show the global one only.

## 3. Decision cases

`/momentum test` runs the virtual-user call and prints the decision **without
sending anything**. With no argument it reads the last assistant message, so you
can probe the conversation as it stands without waiting for a stop; with an
argument it reads that text instead.

`/momentum on` is a mode switch, not an action: it arms the gate for the *next*
time the agent stops. `/momentum test` is the immediate probe.

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
/momentum on
```

Work normally. Every decision appends a rendered block to the transcript:

```
momentum sent → "继续"
ended with a question although a recommendation was stated · 812ms · gpt-5.1-mini
```

Expand it (the entry respects `expanded`) to see the input text it read and the
raw model response. Use `/momentum test` on any message you want to inspect
before it happens. Judge the replies, not the verdicts.

Now check the guardrails:

- **Cap** — keep the agent spinning; after `max` replies the footer shows
  `⚡ capped` and control returns.
- **Reset** — type anything yourself; the counter goes back to `0/N`.
- **Audit** — each injected reply writes a `pi-momentum/virtual-reply` entry.
  `npm run corpus -- <session>` should tag those turns; `npm run analyze` should
  exclude them and print `(N excluded: replies injected by pi-momentum)`.

## 5. The TPS line must survive

With pi-tps installed, end a turn that makes momentum act. The chat should read:

```
TPS 47.5 tok/s. out 431, in 1,722, ...
 momentum sent → "继续"
 waiting for the user · 900ms · model
```

If the TPS line is missing where momentum's block is, momentum wrote a
notification from `agent_settled` and Pi coalesced the two into one line.

## 6. Failure modes to watch for

| symptom | likely cause |
|---|---|
| reply is a question | model ignored the rule; `sanitizeReply` allows questions only if it strips them, check `raw` via `/momentum test` |
| reply picks an option the agent did not recommend | prompt step 3, needs a sharper instruction |
| reply in the wrong language | prompt does not pin the language yet — worth adding |
| everything stops | `never` too broad, or the agent always declares `BLOCKED` |
| `capped` every turn | the agent never declares `DONE`; that is the known weak marker |
| zero model calls when it should decide | `analyzeTurnEnd` matched `BLOCKED`/`DONE` — it only matches at line start |

## 7. What to measure

Per session, once there is real usage:

- **accepted** — the agent continued and you did not intervene
- **wrong turn** — you aborted or corrected within a turn
- **silent stops** — how often it chose `stop`, and whether that was right
- **cost** — one extra completion per stop; watch the cheap-model setting
- **latency** — the delay between the agent stopping and the next turn starting

A wrong turn is the expensive error. If it exceeds roughly one in ten, tighten
the prompt before widening the cap.
