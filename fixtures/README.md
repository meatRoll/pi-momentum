# Fixtures

Two sessions are involved here, and they are not interchangeable. Mixing them up
is easy because both were once referenced as "this session".

| session | role | kept as |
|---|---|---|
| `01a1f161-1eb4-7234-882b-193dd06a2707` | the session that designed and built pi-momentum (`cwd=/Volumes/meatroll_disk/temp`) | `sessions/01a1f161….jsonl` — the migrated transcript (local-only) |
| `01a166c1-ccbf-71ae-a652-4acaf29c56b6` | the 279-turn reverse-engineering session (`cwd=/Volumes/meatroll_disk/temp/guoguoreserve`) that supplies the measurements in the README and `docs/DESIGN.md` | `corpus/01a166c1….json` (committed); the 89 MB raw transcript stays in `~/.pi`, not in this project |

The design session was pointed at the research session to study its turn endings
(`01a1f161` entry #19). That is why the evidence comes from `01a166c1`, while the
session being archived as the project's origin is `01a1f161`.

## Why the origin session has no corpus

`scripts/extract-corpus.ts` counts a turn end only when an assistant **text**
message is followed by a user message. `01a1f161` has three user messages: two
are followed by assistant text, and the last assistant message has no reply
(the session ends there). That yields two turns — enough to archive the
conversation, not enough to score a gate. So it is kept as a transcript only.

## Rebuilding

Raw evidence transcripts are gitignored (`sessions/*.jsonl`); the small origin
transcript is tracked via an exception in `.gitignore`. The committed corpus is
the reproducible artifact:

```bash
npm run corpus -- ~/.pi/agent/sessions/--Volumes-meatroll_disk-temp-guoguoreserve--/2026-10-23T03-15-39-327Z_01a166c1-ccbf-71ae-a652-4acaf29c56b6.jsonl
npm run analyze
```

`corpus/01a166c1….json` records the exact path it was derived from. The 89 MB
transcript is not copied into the project; the corpus is the part that ships.
