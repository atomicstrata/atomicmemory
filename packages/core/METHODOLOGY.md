# Benchmark Methodology

## Dataset: BEAM-100K (LoCoMo-10)

All AtomicMemory quality scores use the **BEAM** (Benchmark for Episodic AI Memory) protocol on the **LoCoMo-10** dataset (100K token context window slice). Dataset licensed CC BY-NC 4.0 from [snap-research/LoCoMo](https://github.com/snap-research/LoCoMo).

Six abilities scored: temporal reasoning (TR), event ordering (EO), contradiction resolution (CR), knowledge update (KU), preference following (PF), multi-session reasoning (MS). Composite = unweighted mean.

## Head-to-Head Numbers (n=180)

These are our primary published numbers. All systems use the same backbone LLM, same judge, same dataset slice, and same scoring protocol — this is an apples-to-apples comparison.

| System | Composite | Configuration |
|--------|:---------:|---------------|
| **AtomicMemory** (research config) | **0.572** | rerank + TBC + contradiction-safe versioning |
| Mem0 (algorithm, local) | 0.550 | mem0ai open-source, local Haiku 4.5 backend |
| Hindsight (HTTP local) | 0.541 | self-hosted, Haiku 4.5 backend |
| Truncation baseline | 0.350 | no memory system, context window only |

Backbone: **Claude Haiku 4.5** · Judge: **Claude Haiku 4.5** · Dataset: LoCoMo-10 BEAM-100K

**Sampling:** n=180 questions drawn from LoCoMo-10 with fixed seed `BEAM-S2-042` across a stratified 4-conversation slice. All systems evaluated on the same slice. Full-dataset (400q) numbers are in the evaluation run history below.

**Note on shipped vs. research configurations:** The **0.572** number above comes from an AtomicMemory research evaluation configuration. The shipped AtomicMemory v1.0 stack in this repo measures **0.411** under a stricter judge. The gap reflects two compounding factors: judge strictness, and configuration changes between the research run (which used "contradiction-safe versioning") and the shipped v1.0 stack (which adds "timeline + observed_at" for harder contradiction handling). The individual contributions have not been isolated. See "Why Scores Differ" below for the judge-variance data.

## Why Scores Differ Across Reports

**Judge choice accounts for ≥0.10 composite variance.** The same AtomicMemory stack scores differently depending on which model acts as judge:

| Judge | AM Composite | Notes |
|-------|:---:|-------|
| Haiku 4.5 | 0.411 | AtomicMemory v1.0 (strict judge, shipped) |
| Sonnet 4.6 | ~0.313 | Stricter rubric application |
| Gemini 2.5 Pro | TBD | planned (Gemini-judge baseline) |

Published competitor numbers use different judges: Hindsight (0.734) uses a Gemini judge; Mem0 (0.641) uses a GPT-5 judge. Direct cross-vendor comparisons require controlling for judge — our head-to-head (0.572) does this.

## Evaluation Run History

| Date | Configuration | Composite | Judge | Notes |
|------|---------------|:---------:|-------|-------|
| 2026-05-07 | Research config — multirun (n=180) | 0.572 | Haiku 4.5 (loose) | **Primary headline** |
| 2026-05-09 | Research config — Opus engine | 0.650 | Haiku 4.5 (loose) | Best single-engine result (research only) |
| 2026-05-11 | AtomicMemory v1.0 (shipped) | 0.411 | Haiku 4.5 (strict) | Shipped stack: rerank+TBC+timeline+observed_at |
| 2026-05-11 | AtomicMemory v1.0 + candidate profile | 0.421 | Haiku 4.5 (strict) | Under validation |

## Cost & Latency

Measured on BEAM-100K with Haiku 4.5 backbone:

- **$0.005/query** (ingest + retrieve combined)
- **<1s p95** retrieve latency
- Compare: Hindsight ~$0.075/query (~15× more expensive)

## Reproducing

The published **0.572** head-to-head was measured against a **frozen evaluation config** — judge model, embedding provider, conversation slice (4 of 10 from LoCoMo-10), and seed `BEAM-S2-042`. Reproducing the exact published scores requires both the frozen config artifact and a pinned commit of `atomicmemory-core`.

### Smoke test (verify your environment is wired up)

The public benchmark harness and canonical smoke command will be linked here
when the frozen evaluation artifact is published. Until then, use the core
quickstart and package tests to verify local service wiring.

### Reproducing the headline numbers

The existing `pnpm --filter atomicbench locomo10` target **will not reproduce the published 0.572 number** out of the box — any drift in defaults (judge, embedding model, slice IDs, seed) produces a different absolute score. The runner is intentionally gated: it requires a populated `configs/canonical-v{N}.json` committed at a `canonical-config-v*` git tag, which pins the exact evaluation configuration.

A dedicated repro target with the frozen config (slice IDs, seed
`BEAM-S2-042`, judge model pin, embedding pin) will be published alongside the
release artifacts. Until that target ships, treat absolute composite numbers
from `locomo10` as indicative-not-authoritative.

## Known Open Questions

- Gemini-judge baseline: re-score AtomicMemory under Gemini judge for direct Hindsight comparison
- BEAM-1M / BEAM-10M: longer-context evaluation planned
- Contradiction-resolution: CR (0.17) is our weakest ability — active area of improvement
