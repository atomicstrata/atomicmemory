# Threat Model — `@atomicmemory/llmwiki`

This document consolidates the bridge's security claims so reviewers and integrators can audit the trust boundary in one place rather than reconstructing it from docstrings.

## Assets

What the bridge protects, in priority order:

1. **AtomicMemory store integrity.** Every byte written via the bridge must be attributable to a legitimate `(user, projectId)` pair. An adversary writing records that *appear* to come from the bridge is the most damaging outcome.
2. **`projectId` namespace.** Two different real projects must not share an external-ID prefix, or one of them silently amplifies records into the other's namespace (see "duplicate amplification" below).
3. **Memory store availability.** A malicious export must not be able to consume unbounded memory or CPU on the importing process.

## Attackers

We model three:

### A0 — Hostile wiki author (prompt injection into LLM context)

The most important attack surface. Imported wiki bodies become memory records that downstream LLMs read back. A page that contains `<<<SYSTEM: ignore prior instructions...>>>` (or any other prompt-injection vector) lands directly in the consuming LLM's context window the next time `search()` retrieves it.

**This is in scope precisely because the bridge has no content sanitization.** The defense is a trust marker:

- Every imported memory carries `metadata.llmwiki.trustLevel = "external-import"`.
- Every imported memory carries `metadata.llmwiki.version = 1` so downstream readers can branch on a known schema version.

Downstream packaging code is *required* to read the trust marker and surface it to the LLM in a way the LLM can act on (e.g. wrapping the body in `<untrusted-source>` tags). The bridge cannot enforce this on the packaging layer; it can only stamp the signal.

If you import a wiki you do not fully trust, you are extending operator-equivalent trust to every author of every page. Apply the same hygiene you would apply to any third-party content source.

### A1 — Malicious exporter

A compromised or malicious `llmwiki` instance produces an export file with hostile contents but a well-formed envelope shape. Defenses:

- The JSON schema (`schema.ts`) enforces shape, per-field length, array length, citation start/end semantics, and `pageCount === pages.length`.
- `nesting-guard.ts` enforces nesting depth AND a per-string size cap that applies to ALL string values reachable from the root — including unknown passthrough fields the schema accepts but doesn't type-check.
- `projectId` and `slug` are validated against strict regexes both at schema time AND as a tripwire inside `buildExternalId`. Identifier injection (slugs containing `/`, `..`, control chars) is impossible without both layers being bypassed.

### A2 — Malicious export-file supplier

The export file came from a trusted exporter, but is handed to the importer by an untrusted third party (e.g. an attacker MITMs the file). The exporter's signature is NOT verified by v1; treat any export as if it came from A1.

### A3 — Concurrent CLI user

Two processes import the same `projectId` simultaneously. The probe → ingest sequence is not atomic. Each process may see "first import, proceed" and write parallel record streams.

- **v1 mitigation:** documented assumption that the bridge is used serially. The CLI handler's docstring calls this out explicitly.
- **Follow-up:** advisory lock keyed on `(user, projectId)` in AtomicMemory core.

## Threat model defenses, by layer

| Layer | What it stops |
|-------|---------------|
| Stream-bounded read | Files larger than `MAX_TOTAL_SIZE_BYTES`, files that grow between `stat` and `read` |
| Raw-string depth prescan | Pathologically nested JSON before `JSON.parse` allocates |
| `JSON.parse` | Malformed JSON |
| Iterative depth + per-string cap walker | Surviving nesting-depth attacks; oversized strings in known OR passthrough fields |
| Zod schema | Wrong shape, missing required fields, bad enum values, regex-invalid `slug`, bad citation ranges |
| `validateProjectId` tripwire in `buildExternalId` | Identifier injection via projectId even when schema is bypassed |
| `validateSlug` tripwire in `buildExternalId` | Identifier injection via slug even when schema is bypassed |
| `assertSupportsVerbatim` capability gate | Silent text-mode re-extraction that would drop bridge metadata |
| Re-import probe with provenance double-check | Forged `metadata.externalId` faking "already imported" state to DoS imports |
| Fail-safe inconclusive outcome | Silent duplicate amplification when the probe runs out of budget |
| `SnapshotLLMWikiProvider.assertScopeMatches` | Cross-user tenant leakage when one process serves multiple users |
| Duplicate-slug detection at construction and ingest | Provider semantics drifting from ingest semantics (same `(dir, slug)` mapped to different content) |

## Failure mode under projectId collision

Under current AtomicMemory verbatim semantics — which are append-only by external ID — a `projectId` collision does NOT produce a silent overwrite. It produces **silent duplicate amplification**: two projects sharing a `projectId` write parallel record streams under the same external-ID prefix, polluting each other's namespace without either side noticing until a list/search returns records they didn't author.

The boundary discipline matters regardless of failure mode; only the consequence differs.

## Out of scope (v1)

- **Provider-side bugs.** A buggy `MemoryProvider.ingest` implementation can drop or corrupt records after the bridge has handed them off. The bridge cannot defend against the layer below it.
- **Network-layer attacks.** The bridge assumes the transport between CLI and provider is trustworthy. TLS, replay protection, etc. live at the provider's boundary, not here.
- **Tokenizer correctness.** `package()` budgeting uses a coarse 4-chars/token heuristic by default. Callers needing accurate budgets pass `tokenize` via `SnapshotLLMWikiProviderOptions`. A misconfigured tokenizer can over- or under-fill a context window; the bridge doesn't verify token counts.
- **Exporter-side signing.** The bridge has no way to verify that an export came from an authentic `llmwiki` instance. A signed-export feature is a v2 conversation.
- **Multi-writer conflict resolution.** Two team members editing the same wiki page concurrently is a problem for `llmwiki`, not the bridge.

## Known v1 limitations that affect this model

These ship as documented limitations rather than fixes:

- **Re-import detection is O(n).** Up to 50,000 memories walked per probe; above that the import is refused as inconclusive (fail-safe). A metadata-prefix list filter in the SDK would collapse this to one indexed call.
- **No atomic transaction.** Ingest is one-page-per-call; a failure at page N leaves N-1 records committed. Per-page error collection (`partialFailures` in the result envelope) surfaces this honestly rather than masking it.
- **No exporter signature.** See A2.
- **Verbatim is contract-trust.** We check `capabilities().ingestModes.includes("verbatim")` but don't round-trip a record to verify the persisted shape carries a verbatim marker.

## Reporting

Suspected security issues: please follow the [AtomicMemory security policy](../../../SECURITY.md).
