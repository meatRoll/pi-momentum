# Fixtures

## What ships

`corpus/sample.json` — a synthetic corpus, ten turn endings in the shape
`scripts/extract-corpus.ts` produces. It exists so `npm run analyze` works on a
fresh clone and so the format is documented. It contains no real session data.

## What stays local

Real transcripts are never committed:

```bash
npm run corpus -- <session.jsonl>   # writes fixtures/corpus/<session-id>.json
npm run analyze                     # scores the newest corpus
```

`fixtures/sessions/*` and any corpus other than `sample.json` are gitignored.
A session transcript can contain hostnames, device identifiers, request headers
and the full text of private conversations, so it belongs in `~/.pi`, not in a
repository.

## Shipped numbers

The measurements quoted in `README.md` and `docs/DESIGN.md` come from a private
279-turn session, scored with the same code that ships here:

| metric | value |
|---|---|
| turns | 279 |
| turn ends with a question to the user | 148 (53%) |
| of those, reply was ≤12 characters | 108 (73%) |
| turns the gate would have continued | 279 (100%) |

The raw transcript and its derived corpus are not part of this repository. The
aggregate figures are, because the tooling that produces them is testable
without the data.
