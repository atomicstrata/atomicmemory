# AtomicMemory Provider Contract — Wire Encoding (v1)

This document pins the wire encodings of the `MemoryProvider` boundary types
that the in-process TypeScript types (`packages/sdk/src/memory/types.ts`) leave
ambiguous. It is the prose companion to the machine-readable schemas under
[`schema/v1/`](./schema/v1/). Cross-language consumers (non-JS callers,
the future dashboard) MUST follow the rules here; they are not inferrable from
the `.ts` types alone.

Versioning: the JSON Schemas carry a top-level `"version": 1` and a `$id`
containing `/v1/`. Breaking changes get a new `v2/` directory, not an in-place
edit.

## 1. Date encoding (`FilterExpr.value`, and Date fields generally)

`FieldFilter.value` is typed `string | number | boolean | Date | Array<...>`
in-process. On the wire there is no `Date`:

- A `Date` operand is encoded as an **ISO-8601 / RFC-3339 date-time string**
  via `Date.prototype.toISOString()` (e.g. `"2026-05-30T12:00:00.000Z"`,
  always UTC, millisecond precision, trailing `Z`).
- The same rule applies to every Date-typed field that crosses the boundary:
  `Memory.createdAt`, `Memory.updatedAt`, `TemporalSearch.asOf`
  (serialized as `as_of`), `observed_at`. These appear as ISO-8601 strings in
  JSON even though the SDK surfaces them as `Date` objects.
- Numeric operands stay numbers; booleans stay booleans; string and
  number arrays serialize as JSON arrays.

Note: `SearchRequest.filter` is part of the contract but the AtomicMemory
provider's `doSearch` does not yet forward `filter` to core. The encoding rule
above is the contract any provider MUST honor once it wires filters; it is not
a claim that AtomicMemory applies server-side filtering today.

## 2. `list` cursor format

The `cursor` returned by `list` (and the `ListResultPage.cursor` / extension
`cursor`) is an **opaque, stringified non-negative integer offset**:

- The provider derives it as `String(previousOffset + pageLength)` and reads it
  back with `parseInt(cursor, 10)`.
- A request with no `cursor` starts at offset `0`.
- `cursor` is **absent** (undefined) on the last page — i.e. when fewer than
  `limit` rows were returned there is no next page and no `cursor` field.
- Treat the value as opaque: do not parse, increment, or otherwise interpret it
  client-side. It is offset-based today; that is an implementation detail behind
  the opaque-string contract.

## 3. `Scope` field mapping

The backend-agnostic `Scope` maps onto AtomicMemory core's wire fields as
follows (see `scope-mapper.ts` and the provider request builders):

| `Scope` field | Wire field | Notes |
| --- | --- | --- |
| `scope.user` | `user_id` | Required by AtomicMemory (`requiredScope.default = ['user']`). |
| `scope.thread` | `session_id` | Emitted on ingest, search, and list only. Routes that do not filter by session (get/delete/expand) must not send or echo it. Returned `session_id` must round-trip the requested `thread`. |
| `scope.namespace` | `namespace_scope` | Workspace/namespace partition for search and packaging. |
| `scope.agent` | *(no direct core field)* | AtomicMemory does not project the generic `Scope.agent` onto a wire field on the core search/list/get path. Agent-scoped behavior is expressed through the AtomicMemory-specific `MemoryScope` workspace variant (`agent_id` / `agent_scope`), which is a separate, namespace-extension surface — not the generic `Scope.agent`. A generic `Scope.agent` value does not silently become `agent_id`. |

## 4. `IngestResult.unchanged`

`IngestResult.unchanged` is **always an empty array on the wire today**.

Core's ingest responses report created and updated memory ids but do not emit a
no-op/deduped set, so the provider populates `created` and `updated` from the
backend and sets `unchanged` to `[]`. Consumers must not infer "nothing was a
duplicate" from an empty `unchanged`; the field is reserved for a future
backend capability and currently carries no signal.

## 5. `score` vs `rankingScore` and cross-provider comparability

`SearchResult` exposes several scalar scores. Their semantics:

- **`score`** — the backward-compatible provider score. For AtomicMemory this
  is the composite `rankingScore` and is **not normalized** (may fall outside
  `[0, 1]`). Other providers preserve their own historical `score` meaning.
  Because the definition is provider-specific, `score` is **not comparable
  across providers** and must not be used for cross-provider thresholds.
- **`similarity`** — raw semantic/vector similarity when the provider exposes
  it. Higher is better. Provider-defined scale.
- **`rankingScore`** — the composite ranking/debug score (RRF-style fusion in
  AtomicMemory). Useful for debugging rank order; **not normalized**.
- **`relevance`** — normalized injection relevance clamped to `[0, 1]`. This is
  the field to use for threshold checks (`SearchRequest.threshold`) and the
  only score with a portable, cross-provider-comparable meaning.

Rule of thumb: filter and gate on **`relevance`**; surface `score` only for
backward-compatible display; use `similarity` / `rankingScore` for debugging.

## 6. Retrieval receipt

The audit-grade retrieval receipt is **snake_case** on the wire, mirroring the
AtomicMemory core search response (`/search` and `/search/fast`). It is the
per-response object plus two per-result fields:

- Per response (`SearchResultPage.retrieval`):
  `embedding_provider`, `embedding_model`, `embedding_model_version`,
  `embedding_dimensions`, `query_text`, `candidate_ids` (returned memory ids in
  ranked order), `trace_id`.
  - `embedding_model_version` is the resolved model id (no supported provider
    exposes a separate immutable version string); it is never fabricated.
  - `embedding_provider` is present on the core wire shape; the
    cross-language required set is the six fields named in the schema's
    `required` list (`embedding_model`, `embedding_model_version`,
    `embedding_dimensions`, `query_text`, `candidate_ids`, `trace_id`).
- Per result (`SearchResult`):
  - `version_id` — the owning claim's `current_version_id`, letting a client
    pin the exact retrieved version as a replay fixture. `null` when the memory
    has no claim version (e.g. workspace-pool rows).
  - `observed_at` — ISO-8601 date-time when the memory was observed/recorded.

The receipt is always present on search responses; it is not gated on retrieval
tracing. It exists so a retrieval can be logged and replayed bit-for-bit, which
is what makes an audited path deterministic.
