# pi-momentum

A turn-end gate for [Pi](https://pi.dev). The agent keeps working as long as it can name a recommendation. It stops only when it declares `⏸ BLOCKED` — meaning it genuinely cannot decide — or `✓ DONE`.

The name is the mechanism: momentum carries a run forward, and an agent only stops when it hits something it cannot push through.

## Why

Measured on a real 279-turn research session:

| | |
|---|---|
| turns that ended in a question | **148 / 279 (53%)** |
| of those, the reply was a one-word "继续/可以/做吧" | **108 (73%)** |
| turns the gate would have continued | 279 (100%) |
| one-word replies that become unnecessary | **197** |

The decisive observation: partway through that session the user typed *"如果不会出现爆盘之类的严重问题，你可以直接执行完，不用询问我"* — and the agent still ended **73 of the next 92 turns** with a question. Prompt-level politeness does not hold. The gate has to sit in the loop.

The raw transcript is private and is not in this repository; the figures above come from running `scripts/analyze.ts` over it. See [`fixtures/README.md`](fixtures/README.md) for what ships.

## Commands

```
/momentum on          # start replying for you
/momentum off         # stop
/momentum test        # simulate the reply for the last message, send nothing
/momentum max 5       # raise the cap
/momentum max off     # no cap at all
```

Arguments complete on Tab, including nested ones (`never add`, `max off`).

The cap is 3 automatic replies per user prompt by default. It exists so the
extension cannot hold an unbounded conversation with itself: every reply you
did not write is a reply that could be wrong, and three is enough for the usual
"继续 / 可以 / 做吧" chain without letting a forty-step task run unattended.

`max` lasts for the session. Make it survive a restart by putting it in the
settings file, where `"infinite"` is the readable way to say "no cap":

```json
{ "global": { "maxContinues": "infinite" } }
```

## What `on` does

When a run goes idle, one isolated one-shot model call reads **only the agent's
last message** and decides whether that text is waiting on the user. If it is,
the same call produces the one-line reply a user would send, and the extension
injects it as a real user message.

The prompt is an intent reader, not a persona: understand what the message is
asking for, then say the thing that keeps it moving. "Asking for" includes the
case where it asks for nothing but announces a next step — "下一步（我接着做）"
and then stops is still a stop, and the only thing a user would say there is
"继续". When the message offers
several options, it takes the one the agent itself recommended; with no
recommendation it takes the smallest, most reversible step. Otherwise it stays
silent and you get the turn back.

`⏸ BLOCKED` and `✓ DONE` short-circuit before the model call: an agent that says
what it is doing costs nothing to respect. The detector's reading of the turn
("stated a next step without executing it") rides along in the user message as
`<turnsignal>`, so the model does not have to rediscover it.

Costs one cheap model call per stop. Pin a model with `"model": "provider/id"`
in the config file; otherwise the active model is used.

The decision call runs at the session's thinking level. A reasoning model called
with no level at all is a different model than the one thinking in your session:
in the session this was measured on, `deepseek-v4.1-flash` at `thinkingLevel:
max` answered cleanly, while the same model with no level stopped one brace
short of a complete decision. A session at `off` sends no level.

A response that stops between tokens is repaired before parsing: a decision whose
fields are complete except for the closing brace still counts. A response cut
inside a string is not repaired — half a sentence in the user's voice is worse
than silence.

Every decision writes a `pi-momentum/decision` entry: action, reply, reason, the
text it read, the raw model response, the model that actually answered, the
thinking level, the response's stop reason, and latency. Entries that were
actually sent carry `sent: true`, so a transcript can always tell a human from
the extension.

## `test`

```
/momentum test                       # the conversation as it stands
/momentum test 要我继续吗？           # arbitrary text
```

Runs the same decision and prints action, reply, reason, `would send`, the input
it read and the raw model response. Nothing is sent and nothing is logged, so it
is free to try repeatedly — the way to check a prompt change or a never-rule
without waiting for a real stop.

### Never-list

The virtual user must not authorize things you never want. A rule is a hard
prefix in the prompt *and* a guardrail applied to the generated reply.

Everything lives in **one file**, with exactly two scopes:

```
~/.pi/agent/momentum.json

{
  "global": { "never": ["别删库"], "model": "provider/id", "maxContinues": 3 },
  "directories": {
    "/abs/path/to/project": { "never": ["不要碰 vendor/"], "replace": false }
  }
}
```

The directory scope is the working directory, matched exactly (realpath, so a
symlink does not create a second entry). No `.pi/momentum.json` files anywhere:
one place to look, one place to edit, and a stray file in a parent directory
cannot change behaviour you cannot see.

```bash
/momentum never list                  # [global] / [dir] per rule, plus terms
/momentum never add 不要碰 web 层     # this directory
/momentum never add --global 别删库    # every directory
/momentum never add --raw 别动 x      # skip normalisation, store the text as typed
/momentum never rm                   # pick one from a list
/momentum never rm 不要碰 web 层       # or name it, removing it from its scope
/momentum dirs                        # every directory with its own rules
```

Global rules apply first, then the directory's. `"replace": true` in a directory
entry drops the global list for that directory. A duplicate is owned by the
directory scope. Scalars (`model`, `maxContinues`) fall back from directory to
global.

`add` runs one model call to turn the sentence into match terms. You write
"别让它在没问我之前就跑数据库迁移"; it stores

```json
{ "text": "不许改数据库迁移", "terms": ["数据库迁移", "迁移脚本", "schema 变更"] }
```

The text is what the model reads; the terms are what the guardrail matches
against. Neither is derived from the other, which is why a rule written the way
a person writes rules still fires. `--raw` keeps the sentence and falls back to
the heuristic stripper.

Rules without terms are matched after stripping the prohibition and the verb, so
`不许改数据库迁移` blocks a reply saying `改数据库迁移` — the literal would never
fire. A comma-separated rule splits into separate terms. Over-blocking is the
intended failure direction: a rejected reply is silence, a missed one is a
fabricated instruction.

Built-in patterns cover five default categories (install software,
delete/overwrite data, publish/deploy/push, change system config, pay for things)
even when every list is empty.

If a `.pi/momentum.json` is sitting in the working directory from an older
version, the extension says so on startup and ignores it.

## Safety

- **Cap.** At most `max` (default 3) continuations per user turn. The counter resets only on a human prompt.
- **`stop` is the default** in virtual mode: a malformed or uninferable answer sends nothing.
- **Aborted runs never resume** (`event.aborted`).
- **Audit entry** per injected reply.

## Markers

```
⏸ BLOCKED
卡点：要不要清掉 470MB 可重建的中间产物
候选：A 清掉 / B 保留
推荐：A —— 都能重建，但删除不可逆，需要你确认
```

```
✓ DONE
190 测试绿，工作区干净，没有遗留项。
```

Markers must open a line. A bare mention inside a sentence (*"mark the ticket `blocked`"*) does not count.

## Install

```bash
pi install git:github.com/meatRoll/pi-momentum
```

Or try it for one run without installing:

```bash
pi -e git:github.com/meatRoll/pi-momentum
```

From a checkout: `pi -e /path/to/pi-momentum`.

## Developing

No build step: Pi loads the TypeScript through jiti. The scripts use Node's type stripping.

```bash
npm test      # extension smoke tests + detector regression cases
npm run analyze
```

```bash
npm run corpus -- <session.jsonl>   # rebuild the fixture corpus
npm run analyze -- --session <session.jsonl>
```

`npm run analyze` reads the newest corpus in `fixtures/corpus/`, replays the detector over every turn end, and reports how many turns the gate would have continued and how many of those the user answered with a one-word "继续".

## Layout

```
src/detect.ts    turn-end analysis, marker parsing (pure, no Pi imports)
src/virtual.ts   virtual-user prompt, decision parsing, reply guardrails (pure)
src/config.ts    never-list + model settings, one file, global and directory scopes
src/rules.ts     system prompt contract
src/index.ts     the extension: modes, gate, cap, commands
scripts/         corpus extraction + offline scoring
test/smoke.ts    fake ExtensionAPI harness, no Pi boot required
test/virtual.ts  decision parsing and guardrail cases
fixtures/        synthetic evidence corpus (real transcripts stay private)
docs/DESIGN.md   evidence, rule derivation, open questions
```
