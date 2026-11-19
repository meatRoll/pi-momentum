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
```

Arguments complete on Tab, including nested ones (`never add`, `max 3`).

## What `on` does

When a run goes idle, one isolated one-shot model call reads **only the agent's
last message** and decides whether that text is waiting on the user. If it is,
the same call produces the one-line reply a user would send, and the extension
injects it as a real user message.

The prompt is an intent reader, not a persona: understand what the message is
asking for, then say the thing that keeps it moving. When the message offers
several options, it takes the one the agent itself recommended; with no
recommendation it takes the smallest, most reversible step. Otherwise it stays
silent and you get the turn back.

`⏸ BLOCKED` and `✓ DONE` short-circuit before the model call: an agent that says
what it is doing costs nothing to respect.

Costs one cheap model call per stop. Pin a model with `"model": "provider/id"`
in the config file; otherwise the active model is used.

Every decision writes a `pi-momentum/decision` entry: action, reply, reason, the
text it read, the raw model response, latency and model. Entries that were
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

The virtual user must not authorize things you never want. It is a hard prefix in the prompt *and* a regex guardrail applied to the generated reply.

Rules are scoped by **directory path**. Every ancestor of the working directory may own a `.pi/momentum.json`, and they fold shallow to deep:

```
~/.pi/agent/momentum.json                  personal, applies everywhere
<project>/.pi/momentum.json                the whole project
<project>/packages/foo/.pi/momentum.json   just this package
```

```json
{
  "never": ["不要碰 vendor/", "不许改数据库迁移"],
  "replace": false
}
```

There is no `.git` sniffing: a layer is simply a directory that has the file. That is what makes a monorepo work — `packages/a` and `packages/b` are separate scopes, not one repository-wide blob.

Lists merge shallow to deep, so a package adding its own rules never silently drops `别删数据` from above. A layer that sets `"replace": true` discards every shallower list; everything below it still accumulates. Duplicates stay where they first appeared but belong to the deepest layer that declares them.

Scalars (`model`, `maxContinues`) take the deepest value.

```bash
/momentum never list                  # shows [global] / [dir] per rule
/momentum never add 不要碰 web 层     # deepest existing layer, else cwd
/momentum never add --global 别删库    # the user file
/momentum never rm 不要碰 web 层       # edits the file that declares it
```

Rules are matched after stripping the prohibition and the verb, so `不许改数据库迁移` blocks a reply saying `改数据库迁移` — matching the literal would never fire. A comma-separated rule splits into separate terms. Over-blocking is the intended failure direction here: a rejected reply is silence, a missed one is a fabricated instruction.

Built-in patterns cover five default categories (install software, delete/overwrite data, publish/deploy/push, change system config, pay for things) even when every layer is empty.

Config keys, every layer: `never`, `replace`, `model`, `maxContinues`.

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
src/config.ts    never-list + model settings, global and project scopes
src/rules.ts     system prompt contract
src/index.ts     the extension: modes, gate, cap, commands
scripts/         corpus extraction + offline scoring
test/smoke.ts    fake ExtensionAPI harness, no Pi boot required
test/virtual.ts  decision parsing and guardrail cases
fixtures/        origin session transcript + derived evidence corpus
docs/DESIGN.md   evidence, rule derivation, open questions
```
