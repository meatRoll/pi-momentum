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

## Modes

```
/momentum virtual    # read the last message, reply in the user's voice when it is waiting
/momentum nudge      # fixed instruction telling the agent to keep going
/momentum off
/momentum dry        # decide, print what it would do, send nothing
/momentum max 5      # raise the continuation cap
```

Both modes stop when the agent declares `⏸ BLOCKED` or `✓ DONE`.

### virtual

When a run goes idle, one isolated one-shot model call reads **only the agent's last message** and decides whether that text is waiting on the user. If it is, the same call produces the one-line reply a user would send, and the extension injects it as a real user message.

The prompt is an intent reader, not a persona: understand what the message is asking for, then say the thing that keeps it moving. When the message offers several options, it takes the one the agent itself recommended; with no recommendation it takes the smallest, most reversible step. Otherwise it stays silent.

Costs one cheap model call per stop. Pin a model with `"model": "provider/id"` in the config file; otherwise the active model is used.

Every injected reply also writes a `pi-momentum/virtual-reply` entry, so a transcript can always tell a human from the extension.

### nudge

Runs on `agent_before_settle`, the last actionable boundary before a run goes idle. If the last assistant message carried neither marker, it appends a fixed instruction and asks for one more provider request. No extra model call.

### Never-list

The virtual user must not authorize things you never want. It is a hard prefix in the prompt *and* a regex guardrail applied to the generated reply.

Rules are scoped **per repository**:

| scope | file | applies to |
|---|---|---|
| `repo` | `<git-root>/.pi/momentum.json` | this repository only |
| `global` | `~/.pi/agent/momentum.json` | every project |

```json
{
  "never": ["不要碰 vendor/", "不许改数据库迁移"],
  "replace": false
}
```

The repo file is resolved from the **git root**, not the working directory, so starting Pi in `packages/foo/src` still finds the rules for the repository. Lists merge by default — a repo adding its own rules should not silently drop `别删数据`. Set `"replace": true` in the repo file when a repository genuinely needs a clean slate.

```bash
/momentum never list                  # shows [repo] / [global] per rule
/momentum never add 不要碰 web 层     # writes the repo file
/momentum never add --global 别删库    # writes the user file
/momentum never rm 不要碰 web 层
```

Built-in patterns cover five default categories (install software, delete/overwrite data, publish/deploy/push, change system config, pay for things) even when both lists are empty.

Config keys, both scopes: `never`, `replace`, `model`, `maxContinues`.

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
