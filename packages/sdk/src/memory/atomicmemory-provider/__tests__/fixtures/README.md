# Fixture record/replay for the AtomicMemory provider mappers

Captured-once, replayed-on-every-CI-run JSON fixtures for the three
provider mappers: `toMemory`, `toIngestResult`, `toSearchResult`
(see `../../mappers.ts`). They cover the contract boundary between
`atomicmemory-core`'s snake_case HTTP responses and the V3 `Memory`
/ `IngestResult` / `SearchResult` types webapp-side consumers
depend on.

## File layout

For each captured endpoint we keep a **pair**:

- `<endpoint>.raw.json` — the verbatim core response, with volatile
  fields (timestamps, UUIDs, embeddings, monotonic counters,
  per-run `user_id`) normalized to fixed stand-ins.
- `<endpoint>.mapped.json` — the expected mapper output, generated
  by running the mapper against `<endpoint>.raw.json` at capture
  time. Stored in JSON form (Date instances become ISO strings).

`_meta.json` records traceability: capture timestamp, the core
SHA + branch, dirty/override flags, and a snapshot of the
provider config at capture time. Not asserted by tests.

## Refresh procedure

1. In `packages/core`, ensure `.env` has a
   real `OPENAI_API_KEY` (or `LLM_PROVIDER=ollama` with a reachable
   ollama server). Bring core up on the standard port 17350:

       docker compose up -d --build

   Do NOT use `docker compose down -v` against the standard
   compose — that would delete your dev `pgdata` volume. The
   capture script uses a unique-per-run `user_id`, so prior data
   on other users does not pollute the captured fixtures.

2. From this repo:

       pnpm fixtures:capture

   The script will fail-fast if `packages/core` has uncommitted
   changes (the captured fixtures wouldn't be reproducible from
   the recorded SHA). Set `ALLOW_DIRTY_CAPTURE=1` to acknowledge a
   local-only capture; `_meta.json` will record the override.

3. Inspect the diff in this directory:

   - `*.raw.json` changes → real core wire-shape change; verify deliberate.
   - `*.mapped.json` changes → mapper handling change; verify deliberate.
   - `_meta.json`: confirm `dirty: false` and the SHA matches the
     core commit you intend to be capturing against.

4. Commit both halves of every changed pair together. Stale
   single-side commits are exactly what these fixtures exist to
   prevent.

## Why not byte-identical-across-refreshes

The full `/v1/memories/ingest` path calls the LLM via
`consensusExtractFacts`, so its output content drifts even at
temperature 0. Search / search-fast / list responses ECHO content
from those memories, so they drift too. `/search` itself can
also invoke LLM-driven repair-loop / query-expansion paths
depending on config. Treat the entire fixture set as "captured
once, manually reviewed on every refresh." The replay tests don't
need byte-identical-across-refreshes — they only need raw → mapped
to be consistent within a single capture.

## What's normalized at capture time

Recursive deep walk over each captured response, applied once
before either the raw or mapped fixture is written so the pair
stays aligned:

- Per-run user (`fixture-capture-<timestamp>`) → canonical
  `"fixture-capture"`
- Memory IDs (UUIDs) → `FIXTURE-MEM-1`, `FIXTURE-MEM-2`, … in the
  order they first appear in any response. Includes:
  - The `id` field on memory rows
  - Memory-ID arrays: `stored_memory_ids`, `updated_memory_ids`,
    `citations`, `included_ids`, `dropped_ids`, `final_ids`
  - Memory-ID-keyed objects: `evidence_roles` keys
- Episode IDs → `FIXTURE-EP-1`, `FIXTURE-EP-2`, …
- `cmo_id` UUIDs → `FIXTURE-CMO-1`, …
- Every field whose name ends in `_at` (`created_at`, `updated_at`,
  `observed_at`, `last_accessed_at`, etc.) → fixed ISO
  `2026-04-24T10:00:00.000Z`
- `access_count`, `version`, `episode_index` → `0`
- `embedding` arrays → `[]` (huge non-deterministic float arrays;
  the mapper doesn't read them)

Anything NOT in that list is preserved verbatim. If a future core
release adds new volatile fields, extend `scripts/capture-fixtures.ts`
and re-run capture; the diff will surface the new field.
