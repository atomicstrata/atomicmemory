# AlignBench

A small, focused benchmark that exercises one failure mode in agentic-memory
recall: the alignment gap between **stored fact phrasing** and **query
phrasing**.

## Why

Several observed failures share the same signature:

1. SDK partner demo: "what is my name?" returns no recall, but
   "what is the user's name?" returns the same fact at cosine 0.51.
2. LongMemEval-S full n=500: 31% of failures are "I don't have info" refusals
   when the answer text is in the haystack.
3. BEAM Knowledge-Update regressions: model picks an older value because
   retrieval brings in keyword-matching chunks rather than the freshest one.

These manifestations share one root: **embedding-and-threshold retrieval
silently returns empty when query phrasing diverges from stored phrasing**,
rather than degrading gracefully.

AlignBench isolates this in a controlled set (~100 items) so we can:
- Quantify the gap on the default SDK embedding stack
- Ablate three independent fixes (query rewrite / dual-storage / hybrid BM25)
- Pick the dominated point and regression-test against committed LoCoMo10 and
  BEAM-1M numbers before shipping.

## Items

`items.json` — one array of test cases. Each case:

```json
{
  "id": "pronoun-001",
  "axis": "pronoun",                 // pronoun | temporal | specificity | negation | control
  "fact": "The user's name is Alex.",
  "query": "what is my name?",
  "gold_in_topk": true,              // expected presence in top-K
  "gold_answer": "Alex"              // for downstream LLM correctness
}
```

Facts are **shared across queries within an axis** — each query searches the
full fact pool, not just its own gold fact. That mimics real recall behavior.

## Variation axes

| Axis | What it varies | Why it matters |
|---|---|---|
| pronoun | `my X` vs `the user's X` vs `X of <name>` | Tests bi-encoder pronoun alignment (dominant SDK failure) |
| temporal | `live in Y` vs `lived in Y` vs `as of 2026, live in Y` | Tests knowledge-update / temporal-anchor handling |
| specificity | `my dog Apollo` vs `my dog` vs `my pet` | Tests generic-vs-specific retrieval |
| negation | `I don't drink coffee` vs `I drink tea, not coffee` | Tests embedding sensitivity to polarity |
| control | unrelated facts/queries | False-positive floor (top-K shouldn't surface these) |

## Metrics

Per run:
- **recall@1** — gold fact ranked first
- **recall@5** — gold fact in top-5
- **per-axis recall@5** — diagnostic
- **false-positive@5** — unrelated controls leaking into top-K
- **mean rank** of gold (lower is better)
- **median similarity** of gold vs distractors

## Runs

- `runs/baseline.json` — current SDK recall pipeline
- `runs/query-rewrite.json` — query-side pronoun rewrite
- `runs/dual-storage.json` — both phrasings stored
- `runs/hybrid-bm25.json` — BM25 + semantic union
- `runs/combined.json` — winning variants stacked

## Falsification

Pre-registered: if query-rewrite alone doesn't lift recall@5 by ≥0.25 over
baseline, the pronoun hypothesis is wrong and we look at extraction quality
next. Stated here so it's not adjusted after seeing data.
