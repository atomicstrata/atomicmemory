# Fallow Tech Debt Cleanup Plan

## Scope

Branch: `chore/core-fallow-tech-debt`

Baseline command:

```bash
fallow --no-cache
```

Baseline metrics captured at the start of this cleanup:

- Dead-code/dependency issues: 7
- Circular dependencies: 1
- Duplicate clone groups: 219
- Health findings above threshold: 13
- Duplicated lines: 4,788 across 137 files
- Average maintainability: 91.6

## Implementation Results

Coordinator branch: `chore/core-fallow-tech-debt`

Final fallow result:

- `fallow --no-cache --format compact --fail-on-issues` exits 0 without
  external baseline files or a saved regression baseline in `.fallowrc.json`.
- Health gates are clear: no remaining `high-complexity`,
  `refactoring-target`, or circular-dependency findings above the failing
  threshold.
- Duplicate clone groups were reduced from 219 to 174 by extracting shared
  test fixtures, route/schema helpers, and small DB test helpers.
- The remaining duplicate clone backlog is tracked in
  [Deferred Fallow Backlog](#deferred-fallow-backlog).

Tracked security debt:

- `src/services/conflict-policy.ts` contains `TrustContext` and
  `applyTrustOverrides`, but the helper is not active: `applyClarificationOverrides`
  does not accept a trust context and no AUDN caller wires agent-trust data into
  this policy path. This fallow cleanup preserves runtime behavior, so real
  low-trust overwrite prevention is deferred to a separate security/product fix.
  That follow-up must define the multi-agent trust policy, pass trust context
  through the AUDN conflict policy, and add regression tests proving lower-trust
  agents cannot silently `UPDATE`, `DELETE`, or `SUPERSEDE` higher-trust memory.

Pull request packaging:

- Keep this cleanup in one PR, per coordinator decision after audit. Because the
  PR spans multiple workstreams in a single review unit, reviewers should treat
  this document as the implementation map and use the final validation gate
  below as the merge readiness signal.

Final validation:

```bash
npm run check:openapi
npx tsc --noEmit
npm test
fallow --no-cache --format compact --fail-on-issues
npm run build
```

## Deferred Fallow Backlog

The strict fallow gate has no external baseline files and no saved regression
baseline in `.fallowrc.json`. The items below are not a merge exemption for a
failing fallow check; they track intentional analyzer configuration and
advisory clone output that should remain visible for future cleanup.

### Optional dependencies kept for Filecoin lazy-load

| Package | Fallow category | Rationale | Owner / workstream |
| --- | --- | --- | --- |
| `@helia/verified-fetch` | `unused-optional-dependency` | Imported only inside the verified-fetch retriever via a dynamic, lazy `import()`. Production builds that do not enable Filecoin retrieval never resolve the package; static analyzers cannot see the runtime call site. Removing the package would break the optional Filecoin retrieval path. | Storage / Filecoin (`src/storage/providers/filecoin/`) |
| `filecoin-pin` | `unused-optional-dependency` | Lazy-loaded by the Filecoin upload pipeline only when an operator has enabled the managed-blob path. Static imports stay out of the hot path so the package is invisible to the analyzer. Removing it would break the optional managed-blob storage mode. | Storage / Filecoin (`src/storage/providers/filecoin/`) |

Both packages live under `optionalDependencies` in `package.json` and are
listed in `.fallowrc.json` `ignoreDependencies` because the runtime call sites
are intentionally lazy. If the Filecoin providers are ever removed wholesale,
delete the package entries and the matching fallow ignores in the same change.

### Remaining duplicate clone families (174 groups)

Test-side duplicates were extracted in Workstream 4; `fallow dupes --no-cache`
still reports 174 clone groups and 3,703 duplicated lines across 112 files.
Under the current fallow CLI this is advisory: the strict merge gate is
`fallow --no-cache --fail-on-issues`, which exits cleanly without a duplication
baseline. The clone families are tracked here so they are not mistaken for
unknown debt.

| Representative family | Approx. clone groups | Rationale for deferral | Owner / workstream |
| --- | ---: | --- | --- |
| Runtime container + config defaults (`src/app/runtime-container.ts`, `src/config.ts`) | ~35 | Config-default literals repeat by design; each duplication is a contract with a specific subsystem. A shared "defaults" helper would obscure which subsystem owns each knob. Revisit only when the config subsystem is being refactored end-to-end. | Future runtime-config workstream |
| Repository / store wrappers (`src/db/repository-*.ts`, `src/db/pg-*-store.ts`) | ~45 | Each `WithClient` variant is a thin wrapper around its pool variant. A higher-order wrapper would add an indirection between callers and the SQL site, which the team has previously decided is more harmful than the duplication. | Future repository-layer redesign |
| Raw-document artifact sync (`src/db/raw-doc-artifact-sync.ts`, `src/db/raw-document-blob-repository.ts`, `src/db/storage-artifact-repository.ts`) | ~25 | The pointer-mode and managed-mode branches share status-update shapes. A unifying helper would couple two storage modes whose lifecycles are diverging in the Filecoin Phase 5 work. | Defer until Filecoin Phase 5 lands |
| Storage provider adapters (`src/storage/providers/**`, `src/storage/__tests__/`) | ~35 | Adapter contract tests duplicate setup per provider for assertion locality. The duplication is the contract; collapsing it hides which adapter exercises which behavior. | Storage / Filecoin |
| Route handler + schema scaffolding (`src/routes/**.ts`, `src/schemas/**.ts`) | ~15 | Per-route Zod schema + handler stanzas repeat by design (OpenAPI emission, request typing). A shared route factory would re-introduce the routing indirection that was deliberately removed. | Out of scope for tech-debt cleanup |
| Inline mock construction in service tests (`src/services/__tests__/*.test.ts`) | ~19 | Remaining test duplication is per-suite mock construction that intentionally mirrors the production call shape. Extraction would obscure the call-shape contract these tests document. | Future test-helper consolidation |

Total tracked: ~174 clone groups, matching the post-Workstream-4 fallow
count. The buckets above are representative cleanup families; every group
reported by `fallow dupes --no-cache` is covered by at least one bucket here.

## Goals

1. Make `fallow --no-cache` pass without broad suppressions for real code debt.
2. Keep each fix small enough to review and validate independently.
3. Preserve runtime behavior, public API behavior, migration behavior, and Filecoin lazy-loading boundaries.
4. Separate analyzer-visibility fixes from real refactors so review can distinguish intentional config from code cleanup.
5. Run all work in the dedicated tech-debt worktree; do not edit the primary `atomicmemory-core` checkout.

## Definition Of Done

This effort is complete only when one of these states is true:

1. `fallow --no-cache --fail-on-issues` exits cleanly.
2. No `.fallow/*baseline*.json` gate remains in the repository.
3. `.fallowrc.json` has no saved `regression.baseline` block.
4. Any intentional fallow configuration that remains is documented in
   [Deferred Fallow Backlog](#deferred-fallow-backlog) with affected files,
   fallow category, rationale, and a follow-up owner/workstream.

In both cases, the full pre-commit gate must pass before the coordinator makes
the final commit:

```bash
npx tsc --noEmit
npm test
fallow --no-cache --fail-on-issues
npm run build
```

## Non-Goals

- Do not fold in the package version bump from the main checkout.
- Do not rewrite broad subsystems just to reduce clone counts.
- Do not remove optional Filecoin packages that are intentionally lazy-loaded.
- Do not change HTTP behavior or OpenAPI output unless a later fix explicitly requires it.
- Do not add timing-based test behavior.

## Workstreams

### 1. Analyzer Visibility And True Dead Code

Purpose: close fallow findings that are artifacts of repo layout or deliberate lazy-loading.

Findings:

- `src/schemas/openapi.ts`: `API_TITLE`, `API_VERSION`, `API_DESCRIPTION`
- `src/services/embedding.ts`: `resolveEmbeddingDimensions`
- `package.json`: optional dependencies `@helia/verified-fetch`, `filecoin-pin`

Plan:

- Confirm whether OpenAPI constants should remain exported for `scripts/generate-openapi.ts`, which is currently ignored by fallow.
- Prefer updating fallow config for intentionally ignored/lazy-loaded dependencies instead of deleting optional packages.
- For `resolveEmbeddingDimensions`, use this tie-breaker:
  - Grep current workspace consumers outside this package.
  - Re-export from `src/index.ts` only if an external consumer exists or docs
    advertise it as public API.
  - Otherwise remove the `export` keyword and keep it private if local code
    still needs it, or delete it if there are no consumers.
- Worker-local validation: `npx tsc --noEmit` and `fallow --no-cache`.

Risk:

- Low for config/export cleanup, medium if public exports change.

### 2. Break The AUDN/TBC Import Cycle

Purpose: remove the real circular dependency:

```text
src/services/memory-audn.ts -> src/services/tbc-execution.ts -> src/services/memory-audn.ts
```

Plan:

- Extract the shared AUDN executor seam from `memory-audn.ts` into a focused module, likely `src/services/audn-decision-executor.ts`.
- Move only the minimal types/functions needed by `tbc-execution.ts`: the exported `executeAudnDecision` path and any private helpers it requires.
- Keep `resolveAndExecuteAudn` and trace construction in `memory-audn.ts`.
- Update tests that import `executeAudnDecision` to import from the new module.
- Run targeted tests:

```bash
dotenv -e .env.test -- npx vitest run "src/services/__tests__/audn-bilateral-preservation.test.ts" --reporter verbose
dotenv -e .env.test -- npx vitest run "src/services/__tests__/typed-belief-calculus.test.ts" --reporter verbose
```

Risk:

- Medium. This touches mutation routing, so behavior must be proven with focused tests before broader checks.

### 3. High-Complexity Function Refactors

Purpose: reduce the 13 health findings with surgical helper extraction.

Complete health-finding inventory:

| Finding | File | Owner |
| --- | --- | --- |
| `buildBaseParams` | `src/db/repository-write.ts` | Codex 2 |
| `createClaimVersionWithClient` | `src/db/repository-claims.ts` | Codex 2 |
| `chat` at line 177 | `src/services/llm.ts` | Claude 2 |
| `tryOpinionIntercept` | `src/services/memory-audn.ts` | Codex 1 |
| `shouldIncludeSupplementalFact` | `src/services/supplemental-extraction.ts` | Claude 3 |
| `cleaned` | `src/services/llm.ts` | Claude 2 |
| `inferCrossEntityRelations` | `src/services/extraction-enrichment.ts` | Claude 3 |
| `applyDeferredDecision` | `src/services/deferred-audn.ts` | Claude 3 |
| `recordOpenAICost` | `src/services/llm.ts` | Claude 2 |
| `chat` at line 234 | `src/services/llm.ts` | Claude 2 |
| `createClaimWithClient` | `src/db/repository-claims.ts` | Codex 2 |
| `generateLegitimateVariations` | `src/services/__tests__/poisoning-dataset.ts` | Codex 3 |
| `resolve` | `src/services/atomicmem-uri.ts` | Codex 3 |

Initial priority order:

1. `src/services/memory-audn.ts`: `tryOpinionIntercept`
2. `src/db/repository-write.ts`: `buildBaseParams`
3. `src/db/repository-claims.ts`: `createClaimVersionWithClient`, `createClaimWithClient`
4. `src/services/llm.ts`: both `chat` functions, `cleaned`, `recordOpenAICost`
5. `src/services/supplemental-extraction.ts`: `shouldIncludeSupplementalFact`
6. `src/services/extraction-enrichment.ts`: `inferCrossEntityRelations`
7. `src/services/deferred-audn.ts`: `applyDeferredDecision`
8. `src/services/__tests__/poisoning-dataset.ts`: `generateLegitimateVariations`
9. `src/services/atomicmem-uri.ts`: `resolve`

Plan:

- Open each file before changing it.
- Extract named predicates and small data builders; avoid behavior changes.
- Keep functions below repo limits: 40 non-comment lines per function, 400 non-comment lines per code/test file.
- Validate each cluster with the most relevant unit tests plus
  `npx tsc --noEmit`. The coordinator still runs the full per-workstream
  commit gate before committing.

Risk:

- Medium to high depending on file. Repository and mutation functions get tighter test gates.

### 4. Duplicate Clone Families

Purpose: reduce 219 clone groups without creating risky abstractions.

Implementation status: the low-risk test-side families listed below were
extracted, dropping the count to 174. The production families that remain
are intentionally deferred and tracked in
[Deferred Fallow Backlog - Remaining duplicate clone families](#remaining-duplicate-clone-families-174-groups);
add new clone families there before accepting them as deferred.

Plan:

- Start with repeated test setup helpers where extraction is low-risk:
  - `src/app/__tests__/document-limits-capabilities.test.ts`
  - `src/app/__tests__/storage-capabilities-app.test.ts`
  - `src/__tests__/smoke.test.ts`
  - `src/app/__tests__/research-consumption-seams.test.ts`
  - repeated repository test setup blocks
- Defer large production clone families until after health/cycle cleanup:
  - `src/app/runtime-container.ts` and `src/config.ts`
  - repository/store wrapper duplication
  - raw document artifact sync duplication
- Extract helpers only when the helper name improves clarity. Leave intentional
  duplication in tests only if refactoring would obscure test intent, and
  document that decision in
  [Deferred Fallow Backlog](#deferred-fallow-backlog).

Stop condition:

- Claude 4 must address the listed low-risk test duplicate families and run a
  fresh `fallow --no-cache`.
- The coordinator then either:
  - continues assigning concrete duplicate families until `fallow --no-cache`
    exits cleanly, or
  - records every remaining clone family in
    [Deferred Fallow Backlog](#deferred-fallow-backlog) with rationale,
    category, affected files, and follow-up owner.
- A workstream cannot be marked complete with an unclassified clone-count
  remainder.

Risk:

- Low for test setup helpers, high for production clone families.

### 5. Validation And Checkpointing

After each workstream:

```bash
npx tsc --noEmit
npm test
fallow --no-cache --fail-on-issues
```

For build/export/package surface changes:

```bash
npm run build
```

For route schema or OpenAPI changes only:

```bash
npm run check:openapi
```

Checkpoint rules:

- Commit each completed workstream separately.
- Use `commit-message.txt` with `git commit -F commit-message.txt`, then delete it.
- Do not commit if `npm test` fails.
- Do not commit if `fallow --no-cache` still fails unless every remaining
  finding is explicitly documented and accepted as a separate follow-up in
  [Deferred Fallow Backlog](#deferred-fallow-backlog).

## Parallel Execution Design

Available implementation capacity:

- Coordinator/supervisor/architect: this agent
- Extra Claude agents: 4
- Extra Codex agents: 3

The coordinator owns the plan, work allocation, merge order, review, final
validation, and commits. Worker agents own only their assigned file sets and
must not edit files outside their write scope without coordinator approval.

### Global Worker Rules

- Start every worker from the dedicated tech-debt worktree, on branch
  `chore/core-fallow-tech-debt` (or a child branch the coordinator assigns).
- Before editing, each worker must run `git status --short --branch`.
- Workers are not alone in the codebase. They must not revert changes made by
  other agents, and they must adapt to already-landed changes.
- Workers must keep changes deterministic and minimal.
- Workers must not create commits. The coordinator commits integrated batches.
- Workers must report:
  - Files changed
  - Fallow findings addressed
  - Tests run
  - Any remaining findings or risks
- If a worker hits cross-scope coupling, it stops and reports instead of
  expanding its write scope.
- The validation blocks below are worker-local minimums. Before any
  per-workstream commit, the coordinator must run the full checkpoint gate,
  including `npm test`.

### Agent Assignments

#### Claude 1 — Fallow Configuration And Analyzer Visibility

Write scope:

- `.fallowrc.json`
- `docs/fallow-tech-debt-cleanup-plan.md`
- Read-only: `scripts/generate-openapi.ts`, `src/schemas/openapi.ts`,
  Filecoin provider vendor loaders

Task:

- Resolve analyzer false positives without hiding real code debt.
- Decide whether OpenAPI constants should be handled by fallow entry visibility,
  inline suppressions, or a small public-surface adjustment.
- Add `@helia/verified-fetch` and `filecoin-pin` to fallow ignore configuration
  only if the lazy-loader evidence supports it.
- Do not remove optional dependencies.

Validation:

```bash
fallow --no-cache --format compact --fail-on-issues
npx tsc --noEmit
```

Dependencies:

- None. Can run immediately.

#### Codex 1 — AUDN/TBC Cycle Break

Write scope:

- `src/services/memory-audn.ts`
- `src/services/tbc-execution.ts`
- New focused file under `src/services/` if needed, likely
  `src/services/audn-decision-executor.ts`
- Tests that directly import `executeAudnDecision`:
  `src/services/__tests__/audn-bilateral-preservation.test.ts`
  `src/services/__tests__/typed-belief-calculus.test.ts`

Task:

- Break the `memory-audn.ts -> tbc-execution.ts -> memory-audn.ts` import
  cycle.
- Preserve existing mutation behavior exactly.
- Keep trace construction in `memory-audn.ts`; move only the executor seam and
  required helpers if extraction is needed.

Validation:

```bash
dotenv -e .env.test -- npx vitest run "src/services/__tests__/audn-bilateral-preservation.test.ts" --reporter verbose
dotenv -e .env.test -- npx vitest run "src/services/__tests__/typed-belief-calculus.test.ts" --reporter verbose
npx tsc --noEmit
fallow --no-cache --format compact --fail-on-issues
```

Dependencies:

- None, but merge before other edits touching `memory-audn.ts`.

#### Codex 2 — Repository Complexity Refactor

Write scope:

- `src/db/repository-write.ts`
- `src/db/repository-claims.ts`
- Directly related tests under `src/db/__tests__/` only if needed

Task:

- Reduce fallow complexity findings:
  - `buildBaseParams`
  - `createClaimWithClient`
  - `createClaimVersionWithClient`
- Prefer helper extraction and named parameter objects.
- Preserve SQL behavior and transaction semantics.

Validation:

```bash
dotenv -e .env.test -- npx vitest run "src/db/**/__tests__/*.test.ts" --reporter verbose
npx tsc --noEmit
fallow --no-cache --format compact --fail-on-issues
```

Dependencies:

- None. Can run in parallel with Codex 1 because write scopes are disjoint.

#### Claude 2 — LLM Service Complexity Refactor

Write scope:

- `src/services/llm.ts`
- Directly related LLM tests under `src/services/__tests__/` only if needed

Task:

- Reduce fallow complexity findings in:
  - `cleaned`
  - `recordOpenAICost`
  - both `chat` functions
- Preserve provider behavior, error handling, and cost logging.
- Do not introduce fallback modes.

Validation:

```bash
dotenv -e .env.test -- npx vitest run "src/services/__tests__/*llm*.test.ts" --reporter verbose
npx tsc --noEmit
fallow --no-cache --format compact --fail-on-issues
```

Dependencies:

- None. Can run immediately.

#### Claude 3 — Extraction And Deferred AUDN Complexity

Write scope:

- `src/services/supplemental-extraction.ts`
- `src/services/extraction-enrichment.ts`
- `src/services/deferred-audn.ts`
- Directly related tests under `src/services/__tests__/` only if needed

Task:

- Reduce fallow complexity findings:
  - `shouldIncludeSupplementalFact`
  - `inferCrossEntityRelations`
  - `applyDeferredDecision`
- Use small predicate/helper extraction.
- Preserve fail-closed mutation behavior.

Validation:

```bash
dotenv -e .env.test -- npx vitest run "src/services/__tests__/*extraction*.test.ts" --reporter verbose
dotenv -e .env.test -- npx vitest run "src/services/__tests__/*deferred*.test.ts" --reporter verbose
npx tsc --noEmit
fallow --no-cache --format compact --fail-on-issues
```

Dependencies:

- None, unless Codex 1 moves shared AUDN types. If that happens, rebase after
  Codex 1 is merged.

#### Codex 3 — URI And Test Fixture Complexity

Write scope:

- `src/services/atomicmem-uri.ts`
- `src/services/__tests__/poisoning-dataset.ts`
- Directly related tests only

Task:

- Reduce fallow complexity findings:
  - `resolve`
  - `generateLegitimateVariations`
- Preserve URI parsing behavior and poisoning dataset shape.

Validation:

```bash
dotenv -e .env.test -- npx vitest run "src/services/__tests__/*poison*.test.ts" --reporter verbose
dotenv -e .env.test -- npx vitest run "src/services/**/__tests__/*uri*.test.ts" --reporter verbose
npx tsc --noEmit
fallow --no-cache --format compact --fail-on-issues
```

Dependencies:

- None. Can run immediately.

#### Claude 4 — Duplicate Test Helper Extraction

Write scope:

- Test helper files under `src/**/__tests__/`
- New helper files under `src/**/__tests__/helpers/`
- Initial target tests:
  - `src/app/__tests__/document-limits-capabilities.test.ts`
  - `src/app/__tests__/storage-capabilities-app.test.ts`
  - `src/__tests__/smoke.test.ts`
  - `src/app/__tests__/research-consumption-seams.test.ts`
  - small repeated repository test setup blocks

Task:

- Reduce low-risk duplicate clone families in tests.
- Do not touch production source.
- Preserve test readability; avoid abstractions that hide the behavior being
  asserted.

Validation:

```bash
dotenv -e .env.test -- npx vitest run "src/app/__tests__/document-limits-capabilities.test.ts" --reporter verbose
dotenv -e .env.test -- npx vitest run "src/app/__tests__/storage-capabilities-app.test.ts" --reporter verbose
dotenv -e .env.test -- npx vitest run "src/__tests__/smoke.test.ts" --reporter verbose
dotenv -e .env.test -- npx vitest run "src/app/__tests__/research-consumption-seams.test.ts" --reporter verbose
npx tsc --noEmit
fallow --no-cache --format compact --fail-on-issues
```

Dependencies:

- Should start after Codex 1 if it plans to touch typed-belief/AUDN tests.
- Otherwise can run immediately.

### Coordinator Responsibilities

The coordinator does not compete with workers for implementation scope. The
coordinator will:

- Maintain strict fallow status after each merge.
- Assign or pause agents based on file conflicts.
- Review every worker diff before integration.
- Resolve conflicts manually when needed.
- Run the final gate:

```bash
npx tsc --noEmit
npm test
fallow --no-cache --fail-on-issues
npm run build
```

- Commit integrated phases with temporary `commit-message.txt` files.
- Update [Deferred Fallow Backlog](#deferred-fallow-backlog) only for accepted
  remaining debt, not for avoidable failures.

### Merge Order

1. Claude 1: analyzer visibility, because it may reduce false positives before
   workers chase them.
2. Codex 1: AUDN/TBC cycle break, because it owns shared AUDN files.
3. Codex 2, Claude 2, Claude 3, Codex 3: complexity refactors in parallel,
   merged one at a time after targeted validation.
4. Claude 4: duplicate test helper cleanup, merged after any test files touched
   by earlier workers settle.
5. Coordinator final fallow pass and any small integration fixes.

### Conflict Rules

- If two workers need the same file, the coordinator assigns ownership to one
  worker and converts the other task to read-only analysis.
- `memory-audn.ts` is reserved for Codex 1 until the import cycle fix is merged.
- Production duplicate cleanup is postponed until after all complexity fixes, so
  workers do not extract helpers around code that is still moving.
- Any change to `openapi.yaml` or `openapi.json` requires coordinator approval
  and `npm run check:openapi`.
