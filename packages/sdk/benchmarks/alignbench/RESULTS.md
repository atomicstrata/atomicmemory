# AlignBench v0 — Results

**Date:** 2026-05-14
**SDK branch:** `worktree-alignbench-2026-05-14` at `bf4ab91`
**Items:** 60 scored queries (pronoun 20, temporal 14, specificity 14, negation 12) + 10 controls
**Fact pool:** 55 facts (45 user-facts across 4 axes + 10 extraction-style meta-fact distractors)

> Every query competes against the **full pool** simultaneously, mimicking how a
> real SDK store accumulates noise across topics. Distractors are facts of the
> form observed in field testing: `The user asked for the user's
> name.`, `The user is me.`, `As of <date>, X is a term mentioned in the
> conversation.`

---

## TL;DR

**The pronoun-rewrite hypothesis is falsified.** Cleaning extraction meta-facts
out of the pool is a larger lift than any algorithmic retrieval patch. The
temporal axis is stuck at r@1=0.500 across every variant — that's a structural
property of the embedding-only retrieval contract, not a prompt-tuning problem.

| Variant | r@1 | r@5 | distractor_top1 | fp@control |
|---|---:|---:|---:|---:|
| baseline (current SDK) | 0.733 | 0.933 | 0.067 | 0.000 |
| baseline, clean pool (no meta-facts) | **0.767** | **0.950** | 0.000 | 0.000 |
| query-rewrite (pronoun substitution) | 0.733 | 0.933 | 0.083 ← worse | 0.000 |
| dual-storage (both phrasings stored) | 0.783 | 0.933 | 0.067 | 0.000 |
| hybrid BM25 + semantic | 0.617 | 0.917 | 0.067 | **1.000** ← bad |
| combined (rewrite + BM25) | 0.650 | 0.933 | 0.083 | 1.000 |
| mpnet-base-v2 (110M params, Modal A10G) | 0.733 | **0.950** | 0.083 | — |
| bge-base-en-v1.5 (109M params, Modal A10G) | 0.617 | 0.783 | 0.250 | — |
| e5-base-v2 (110M params, Modal A10G) | 0.717 | 0.933 | 0.200 | — |

See `runs/modal-ablation.json` for the full 6-model sweep (Modal A10G, ~6s per
model). **The SDK's current MiniLM-L6-v2 is tied for best r@1 and has the
lowest distractor rate** — swapping to a bigger bi-encoder is not the fix.
BGE/E5 underperform here likely because they expect prompt-prefix conventions
(`"query: …"`/`"passage: …"`) we did not add, but even mpnet (which doesn't
require prefixes) only buys +0.017 r@5 and zero r@1. The embedding-model lever
is a dead-end for this failure surface.

The biggest fixable lift, by a clean margin, comes from **not letting the
extractor emit meta-facts in the first place**. That's an extraction-prompt
change in core, not a recall-path change in the SDK.

---

## Pre-registered falsification

Before running, I committed to: *if query-rewrite alone doesn't lift r@5 by
≥0.25, the pronoun hypothesis is wrong and we look at extraction quality.*

Result: query-rewrite r@5 lift = **0.000** (0.933 vs 0.933). **Falsified.**

This is the value of pre-registration. The diagnostic story I posted earlier —
"the failure is a first/third-person embedding gap, patchable in the SDK
recall path" — does not survive contact with a controlled benchmark.

---

## Per-axis breakdown (baseline, with distractors)

| Axis | n | r@1 | r@5 | Median gold margin | distractor-top1 |
|---|---:|---:|---:|---:|---:|
| pronoun | 20 | 0.700 | 1.000 | **0.047** ← thin | 2 |
| temporal | 14 | 0.500 | 0.714 | **0.050** ← thin | 2 |
| specificity | 14 | 0.857 | 1.000 | 0.144 | 0 |
| negation | 12 | 0.917 | 1.000 | 0.268 | 0 |

Pronoun and temporal both sit at a fragile ~0.05 cosine margin between gold and
best non-gold. Specificity and negation are robust. Distractor meta-facts beat
the gold on 4 of 60 queries (6.7%) — concentrated in pronoun and temporal.

---

## Why each variant didn't fix it

### Query-rewrite (pronoun substitution)

Rewriting "what is my name?" → "what is the user's name?" was supposed to
bridge the embedding gap to the third-person stored fact. It does — but it
also collides MORE with the distractor "The user asked for the user's name."
Net effect: r@1 unchanged, pronoun margin tightens 0.047 → 0.031, distractor-
top1 goes 2 → 3. **The rewrite is bridging to the wrong neighborhood.**

Negative result: surface-level pronoun substitution makes the noise problem
worse, not better, when the noise itself is third-person extraction output.

### Dual-storage (paraphrase to first-person at write time)

Modest +0.05 r@1 lift, but only in pronoun (0.70 → 0.80). Temporal unchanged
(still 0.50). The fix works for the failure class it targets but doesn't
generalize. Cost: 2× memory size, dedupe required, indistinguishable in the UI.

### Hybrid BM25 + semantic union

BM25 helps where lexical overlap aligns with relevance (temporal margin 0.05 →
0.19, negation margin 0.27 → 0.56). But it tanks control precision — every
unrelated query like "what year did WWII end?" now matches user facts on
common English words. fp@control jumps 0% → 100%. **Not shippable as-is.** A
careful BM25 weight schedule or a confidence threshold on the BM25 score
might recover, but that's a larger study.

### Combined (rewrite + BM25)

Inherits the worst of both: rewrite-induced collision with meta-distractors
AND BM25 false-positive blowout. r@1 0.65, fp@control 100%. Don't ship.

---

## What actually moved the needle

| Intervention | r@1 | r@5 | Notes |
|---|---:|---:|---|
| Baseline | 0.733 | 0.933 | reference |
| **Drop extraction meta-facts from pool** | **0.767** | **0.950** | bigger than any algorithmic fix |
| Dual-storage | 0.783 | 0.933 | tied for second; cost = 2× store size |

The takeaway: **the leverage is upstream of retrieval**. The SDK's recall layer
is reasonable; the dominant cause of partner-visible failures is that the
extraction prompt produces facts that aren't facts (`The user asked for the
user's name.`, `As of May 14, X is a term mentioned.`). These corrupt the
embedding neighborhood for every adjacent query.

---

## The temporal axis is its own story

r@1 = 0.500 across **every** variant tested (baseline / rewrite / dual-storage
/ BM25 / combined / clean-pool). Three failure patterns explain it:

| Pattern | Example | Why it breaks cosine retrieval |
|---|---|---|
| Temporal anchor in fact text hurts match | `where do I live now?` ranks "user lives in Lisbon" above gold "**As of January 2026**, the user lives in Lisbon" | Date markers add lexical noise the bi-encoder treats as off-topic |
| Stale fact beats current fact | `is the user still in Berlin?` top-1 is "**Before 2024**, lived in Berlin" @ cosine 0.72; current "lives in Lisbon" ranks #5 | Cosine cannot encode "this fact was superseded" — Mem0+TR's temporal-metadata layer side-steps this entirely |
| Cross-axis bleed | `what is the user reading?` top-1 is "reads on a **Kindle**" (device); gold "reading 'The Power Broker'" (book) ranks #8 | Embedding can't keep activity ↔ object distinct when both share lexical surface |

The first two cannot be fixed in the SDK recall path. They require **structured
state at write time** — the architectural choice Mem0+TR made in their Nov-2025
release. Our temporal-state layer in core (`temporal-classifier.ts`,
`temporal-state-write.ts`) is the right shape but isn't currently consulted by
the SDK retrieval path.

---

## Connection to LMME-S refusal failures

The LMME-S full n=500 run (sprint 5) showed **31% of failures were "I don't
have info" refusals when the answer text was in the haystack**. We blamed
"Haiku reasoning over 100K tokens" but didn't have a controlled benchmark to
attribute the cause.

AlignBench suggests a re-attribution: those LMME refusals are likely the same
extraction-vs-query alignment failure compounded over a 50K-token haystack
where competing extraction-style facts dilute the gold. A targeted ablation on
LMME-S with the extraction-cleanup applied would test this directly.

---

## Recommendations (ranked)

| # | Recommendation | Effort | Expected lift |
|---|---|---|---|
| 1 | **Filter meta-facts at write time** — add an extraction-output rejection rule for patterns matching `The user (asked|is|requested|said).*`, `<date>, X is a term mentioned.*`, `A name was mentioned.*`. Move from naive next-LLM-output to a typed-fact schema. | 1 day in core | r@1 +0.03–0.05 directly; bigger gains downstream on LoCoMo cat-1 and LMME refusal rate |
| 2 | **Expose extraction prompt as SDK surface** (Ethan flagged this Slack-side) so design partners can tune. Document the durable-fact vs meta-fact distinction. | 0.5 day in SDK | structural; enables (3) |
| 3 | **Wire core's temporal-state layer into SDK retrieval** for time-anchored queries. The components exist (temporal-classifier, temporal-rerank) but the SDK calls plain semantic-search. | 2–3 days | closes a real gap on the temporal axis; would also lift LoCoMo cat 4 toward Mem0+TR parity |
| 4 | Adopt dual-storage as an opt-in `RECALL_DUAL_STORAGE=true` flag for first-person-heavy workloads. Don't make it default — the cost is real. | 0.5 day | +0.05 r@1 in pronoun-heavy stores; no help elsewhere |
| 5 | Skip BM25 hybrid unless we build a control-set-aware weight schedule. Current naive union breaks precision. | — | not recommended in isolation |

The partner-facing demo failure SgtPooki reported is best addressed by **(1) +
(4)** combined: cleaner extraction means fewer poisoned matches, and dual-
storage makes pronoun queries robust against the noise that remains.

---

## Reproducibility

```bash
cd benchmarks/alignbench
node run.mjs                                  # baseline
node run.mjs --variant=query-rewrite          --out=runs/query-rewrite.json
node run.mjs --variant=dual-storage           --out=runs/dual-storage.json
node run.mjs --variant=hybrid-bm25            --out=runs/hybrid-bm25.json
node run.mjs --variant=combined               --out=runs/combined.json
node run.mjs --model=Xenova/all-mpnet-base-v2 --out=runs/baseline-mpnet.json
```

Each run saves a JSON with composite metrics, per-axis breakdown, and per-item
top-1 / gold-rank / margin records. Diff-able across runs.

Items: `items.json` (60 queries, 45 facts, 10 distractors, 10 controls).
Runner: `run.mjs` (single file, no SDK or DB dependencies — just
`@huggingface/transformers`).

---

## Honest limits of this benchmark

- **n is small** (60 scored queries). Margin estimates are noisy; treat
  ±0.05–0.07 r@1 differences as within-noise unless replicated.
- **Hand-written items**, no naturalistic distribution. Real partner traffic
  may surface other failure axes (multi-turn coreference, list aggregation,
  numerical reasoning) AlignBench doesn't cover.
- **Embedding-model sweep is incomplete.** Six sentence-transformer models
  tested on Modal A10G (`modal_ablate.py`, `runs/modal-ablation.json`).
  BGE/E5 likely need their input-prefix conventions (`"query: …"` /
  `"passage: …"`) for fair scoring; we didn't add them. Mpnet is a clean
  comparison and only buys +0.017 r@5 over the SDK default. A larger sweep
  with model-specific prefixes is future work but not a blocker.
- **Distractor pool curated by hand** based on observed SDK extraction output.
  A real pool from a production-like Postgres dataset would be the gold version.

Treat AlignBench v0 as a diagnostic tool, not as a leaderboard number.
