# Concurrent ingest silently drops writes

Status: investigated, not fixed in this branch.
Severity: critical (data loss without surfaced error).
First reported: integration test against the published `atomicmemory-core` image — 5 parallel POST `/v1/memories/ingest` calls with distinct payloads stored only ~2 of 5; the same 5 sequentially stored all 5.

## What the API returns

Response is HTTP 200 with `memories_stored: 2`, `stored_memory_ids: [id1, id2]` despite `facts_extracted: 5`. The 3 lost writes never raise an error; the client only sees the count mismatch.

## Ingest pipeline map

| Layer | File | Notes |
|---|---|---|
| Route | `src/routes/memories.ts:183` (POST `/ingest`) → `handleIngestRequest(mode='full')` | also `/ingest/quick` at line 197 |
| Service | `src/services/memory-ingest.ts:104` `performIngest()` | serial per-fact loop at L123-130 |
| Per-fact | `src/services/ingest-fact-pipeline.ts:59` `processFactThroughPipeline()` | dispatches to full vs quick path |
| Candidate find | `src/services/memory-audn.ts:40` `findFilteredCandidates()` | vector + keyword search before write |
| AUDN decision | `src/services/memory-audn.ts:57` `resolveAndExecuteAudn()` | LLM or rule-based, may defer |
| Canonical write | `src/services/memory-storage.ts:40` `storeCanonicalFact()` | CMO → projection → claim → evidence |
| Projection | `src/services/memory-storage.ts:116` `storeProjection()` | `storeMemory` + atomic facts + foresight |
| Repo write | `src/db/repository-write.ts:107` `storeMemoryWithClient()` | plain INSERT, no `ON CONFLICT`, no tx span |

## Likely race surfaces

1. **`findFilteredCandidates()` runs before INSERT, non-transactional.** Two concurrent ingests with similar embeddings both see zero candidates (each other's writes haven't committed yet). Both pass dedup. Both try to store. No DB-level unique constraint on `(user_id, content)` or `embedding` prevents the second one — but if AUDN flips one of them onto an UPDATE path against a not-yet-committed candidate, the update is a no-op.

2. **Silent skip in lineage emission** — `src/services/memory-lineage.ts:156-157`:
   ```ts
   const memoryId = await event.createProjection(cmoId);
   if (!memoryId) return null;
   ```
   In normal flow `storeMemory` always returns a string (or throws), so `memoryId` should not be null. But this branch *is* the swallow point: if any future change makes projection return null, the bug surfaces silently with no log line.

3. **Deferred AUDN reconciliation** — `src/services/memory-audn.ts:81` + `src/services/deferred-audn.ts:50-54`. When `deferredAudnEnabled=true` and candidates exist, the memory is queued for background reconciliation rather than stored synchronously. The API response counts only the synchronously-stored memories, so deferred writes show up as `memories_stored: 0`. If the background job fails to drain the queue, those writes never materialize.

4. **No transaction spanning the per-fact pipeline.** `storeMemory`, `storeAtomicFacts`, `storeForesight`, and the lineage row inserts are independent statements. Pool exhaustion or a partial failure mid-sequence leaves the response counting only what fully completed.

## Recommended fix (out of scope for this branch)

The cleanest correctness fix is a unique constraint + retry:

1. Add a UNIQUE index on `(user_id, content_hash)` where `content_hash = sha256(content)`. Backfill a `content_hash` column from existing memories.
2. Change `storeMemoryWithClient` to `INSERT ... ON CONFLICT (user_id, content_hash) DO UPDATE SET last_accessed_at = now() RETURNING id, xmax = 0 AS inserted`. The `xmax = 0` trick tells you whether the row is new or pre-existing.
3. Surface the conflict in the response — change the accumulator to distinguish `stored`, `deduplicated`, and `skipped`, and **never** return `stored: 0` without also returning `skipped: N` with the reason.

This eliminates the race window entirely (DB serializes conflicting INSERTs) and removes the silent-skip path (the response always sums to the input fact count).

For the deferred-AUDN path, the response shape should additionally include `deferred: N` so clients see "5 in, 2 stored, 3 deferred" rather than "5 in, 2 stored, ???". And the deferred queue needs a drain-failure log so missed reconciliations are observable.

## Why I didn't ship a fix on this branch

- Adding a `content_hash` column requires a migration (`0002_*` and a backfill plan) plus matching read-path updates.
- Changing the response shape to surface `deferred` / `skipped` reasons is a wire-contract change and touches every consumer (`packages/sdk`, `packages/cli` package response handling, the OpenAPI schema, the smoke and contract tests).
- Reproducing locally requires running the Docker smoke + a custom concurrent-ingest harness; the existing test suite doesn't exercise the race.

Doing this responsibly is multi-day engineering work, not a single-session patch.
