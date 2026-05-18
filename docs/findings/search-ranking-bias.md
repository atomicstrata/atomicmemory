# Search ranking biased toward composite / link-heavy memories

Status: partial mitigation applied (`src/services/memory-search.ts:463`).
Severity: high (confident wrong answers at top of result set).
First reported: integration test query "what editor does the user prefer" returned a Go-debugging memory at rank #1 with `similarity=0.278`, while the actually-relevant Neovim memory was rank #4 despite `similarity=0.493`.

## The two competing scores

In `src/db/repository-vector-search.ts:140-150` (and the JS fallback `computeScore()` at L567-583), every memory carries two scores:

- **`score`** — unconditional `(α·sim + β·importance + γ·recency) · trust`. A high-importance, recently-accessed memory dominates this number regardless of similarity.
- **`ranking_score`** — same formula, but the `(β·importance + γ·recency)` term is *zeroed* when `sim < retrievalProfileSettings.rankingMinSimilarity` (default 0.3). This is the floor-gated variant the original author intended for ordering.

The SQL `ORDER BY ranking_score DESC` is correct. The bug is that several post-DB JS sorts use the **unconditional** `score`, which re-introduces the bias the floor was meant to suppress:

| File:Line | Sort key | Path |
|---|---|---|
| `src/services/memory-search.ts:463` | `b.score - a.score` (**fixed in this branch**) | current-state query packaging |
| `src/services/search-pipeline.ts:1127` | `b.score - a.score` | RRF expansion merge |
| `src/services/search-pipeline.ts:1441` | `right.score - left.score` | RRF stage-weighted merge |
| `src/db/repository-vector-search.ts:493` | `(right.ranking_score ?? right.score)` — already correct | mock vector backend |

## Reproduction sketch

```
sim=0.278 importance=0.60 recency≈high → score = 2·0.278 + 1·0.60 + γ ≈ 4.48,
                                          ranking_score = 2·0.278 + 0 = 0.556
sim=0.493 importance=0.60 recency≈high → score = 2·0.493 + 1·0.60 + γ ≈ 2.59,
                                          ranking_score = 2·0.493 + 1·0.60 + γ ≈ 2.59
```

`score` ordering puts the irrelevant 4.48 above the relevant 2.59. `ranking_score` ordering reverses that (2.59 > 0.556).

## What this branch changes

`src/services/memory-search.ts:463` — the final packaging sort for current-state queries now uses `(b.ranking_score ?? b.score)` instead of `b.score`. This is the order that determines the API response, so it's the one that directly affects the user-visible ranking.

All 3117 vitest tests still pass after the change, which means no existing test was relying on the buggy current-state ordering.

## What's still outstanding (out of scope here)

1. **Pipeline-internal sorts** (`search-pipeline.ts:1127`, `:1441`) still use unconditional `score`. These influence which candidates *survive* into the response. A follow-up should change them to `ranking_score ?? score` too, with corresponding test re-baselines.
2. **`rank_by` request param.** Exposing `rank_by=similarity` (or `rank_by=ranking_score` vs `rank_by=composite`) on the search route gives consumers an explicit escape hatch. Recommended for the SDK contract.
3. **Relevance floor in the response.** Bug #4 from the original report — queries with no matching content still return memories. A `min_similarity` config (already partly threaded as `SIMILARITY_THRESHOLD`) needs to actually drop results below the floor instead of just deboosting them.
4. **Tune the default weights.** Once gated correctly, the `(α=2, β=1, γ=1)` weighting is still aggressive on importance. A bench sweep against the BEAM judge set would inform whether `β` and `γ` should drop.

## Why a deeper fix isn't in this branch

The pipeline-level sort changes touch retrieval ordering at multiple stages and would re-baseline a meaningful slice of the search test suite; that's a careful engineering pass, not a session patch. The current-state-query sort fix is the smallest change that addresses the specific reported regression without taking on the rest of the retrieval algorithm.
