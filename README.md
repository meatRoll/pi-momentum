# pi-momentum

A turn-end gate for [Pi](https://pi.dev). The agent keeps working as long as it can name a recommendation. It stops only when it declares `⏸ BLOCKED` — meaning it genuinely cannot decide — or `✓ DONE`.

The name is the mechanism: momentum carries a run forward, and an agent only stops when it hits something it cannot push through.

## Why

Measured on a real 279-turn research session (`01a166c1…`, corpus in `fixtures/corpus`):

| | |
|---|---|
| turns that ended in a question | **148 / 279 (53%)** |
| of those, the reply was a one-word "继续/可以/做吧" | **108 (73%)** |
| turns the gate would have continued | 279 (100%) |
| one-word replies that become unnecessary | **197** |

The decisive observation: partway through that session the user typed *"如果不会出现爆盘之类的严重问题，你可以直接执行完，不用询问我"* — and the agent still ended **73 of the next 92 turns** with a question. Prompt-level politeness does not hold. The gate has to sit in the loop.

The measurement session (`01a166c1…`) is not the session that built this project (`01a1f161…`). Their roles and provenance are documented in [`fixtures/README.md`](fixtures/README.md).

## How it works

Two pieces:

1. **The contract** (`src/rules.ts`) is injected into the system prompt while the extension is active. It lists the four situations where stopping is legal and the five where it is not.
2. **The gate** (`src/index.ts`) runs on `agent_before_settle` — Pi's final actionable boundary before a run is allowed to go idle. If the last assistant message carried neither marker, the extension appends a nudge and asks for one more provider request instead of handing control back.

Safety valve: at most `max` (default 3) automatic continuations per user turn. A run that spins without progress hits the cap and returns control.

Dry-run is the default. Nothing is injected until you opt in:

```
/momentum enforce     # turn the gate on
/momentum dry         # back to detect-only
/momentum max 5       # raise the cap
/momentum on|off      # master switch
```

The footer shows `⚡ momentum enforce 1/3`.

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

## Usage

```bash
pi -e /Volumes/meatroll_disk/temp/pi-momentum     # try it for one run
pi install /Volumes/meatroll_disk/temp/pi-momentum # install it
```

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
src/rules.ts     system prompt contract
src/index.ts     the extension: inject, gate, cap, commands
scripts/         corpus extraction + offline scoring
test/smoke.ts    fake ExtensionAPI harness, no Pi boot required
fixtures/        origin session transcript + derived evidence corpus
docs/DESIGN.md   evidence, rule derivation, open questions
```
