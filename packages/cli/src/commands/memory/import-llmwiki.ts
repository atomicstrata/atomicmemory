/**
 * @file `atomicmemory import --type llmwiki <export.json>` —
 * bridge import path for llmwiki JSON exports.
 *
 * Calls `@atomicmemory/llmwiki` to parse + validate the export, then
 * writes each page as ONE verbatim memory record via the provider
 * adapter.
 *
 * **Append-only safety.** AtomicMemory's verbatim ingest is not
 * idempotent by external ID — every call creates a new memory record.
 *
 *  - First invocation (no existing memory matches the imported
 *    project's external-ID prefix) runs without extra flags.
 *  - Subsequent invocations REFUSE unless BOTH `--allow-append-only`
 *    AND `--accept-duplicates` are supplied, because re-imports
 *    double every page that hasn't changed.
 *
 * **Re-import detection is fail-safe.** The walk over the user's
 * memory list returns a discriminated outcome:
 *
 *   - `'none'`         — confidently first import; proceed.
 *   - `'found'`        — prior import; refuse unless opt-in flags.
 *   - `'inconclusive'` — list walk exceeded its budget; REFUSE rather
 *     than risk silent duplicate creation.
 *
 * Match criteria require BOTH `provenance.source === "llmwiki"` AND
 * `metadata.externalId.startsWith(prefix)`. Two signals make
 * accidental or malicious bypass harder.
 *
 * **Scope axes.** The bridge has three identity axes — `user`,
 * `namespace`, and `projectId`. The external ID encodes only
 * `projectId`, so an existing import under a *different* namespace
 * still appears as a "found" hit; we surface that as a warning rather
 * than silently treating the namespaces as isolated. Pin `projectId`
 * globally unique per user across namespaces.
 *
 * Cross-namespace detection works by probing with `{ user }` only
 * (namespace and thread stripped). This relies on the active adapter
 * supporting user-scoped listing without further filtering — the
 * common case for AtomicMemory-shaped adapters. Adapters that refuse
 * to list without a namespace will downgrade the cross-namespace
 * warning to a no-op; same-namespace re-import detection still works.
 */

import {
  buildLlmwikiMetadata,
  buildExternalId,
  externalIdPrefixForProject,
  loadLLMWikiExport,
  supportsVerbatim,
  validateProjectId,
  verbatimUnsupportedMessage,
  E_LLMWIKI_VERBATIM_UNSUPPORTED,
  E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE,
  LLMWikiBridgeError,
  type LLMWikiExport,
  type ExportPage,
} from '@atomicmemory/llmwiki';
import { CliError } from '../../types.js';
import type {
  AdapterIngestInput,
  AdapterMemorySummary,
  ProviderAdapter,
} from '../../adapters/types.js';
import type { CliScope, ProviderCapabilities } from '../../types.js';
import type { CommandContext } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';

/** Soft cap on memories walked when detecting re-imports. */
const LIST_WALK_HARD_STOP = 50_000;
/** Per-page pagination size when walking the memory list. */
const LIST_PAGE_SIZE = 100;
/** Sentinel value Commander parses for `--type llmwiki`. */
const TYPE_LLMWIKI = 'llmwiki';

export type ImportType = typeof TYPE_LLMWIKI;

/** Discriminated outcome returned by re-import detection. */
type ReimportProbe =
  | { outcome: 'none' }
  | { outcome: 'found'; id: string; sameNamespace: boolean }
  | { outcome: 'inconclusive'; walked: number };

export interface ImportLlmwikiResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  /**
   * Per-page failures encountered during the ingest loop. Populated
   * when at least one page failed but others may have succeeded —
   * the CLI exits non-zero whenever this array is non-empty so users
   * can spot partial-success outcomes instead of having them masked
   * by an exit code that only reflects the last error.
   */
  partialFailures?: { path: string; externalId: string; message: string }[];
  /** Per-page summary surfaced when --dry-run is true. */
  dryRunPages?: { path: string; externalId: string; bodyBytes: number }[];
  /**
   * Aggregate counts surfaced alongside dryRunPages so the user can
   * answer "is this safe to import?" without iterating the array.
   */
  dryRunSummary?: {
    pageCount: number;
    totalBytes: number;
    projectId: string;
  };
  /** Cross-namespace re-import warning, surfaced when --allow-append-only proceeds. */
  warning?: string;
}

/**
 * Public entry point: dispatch on `--type`. Anything other than
 * `llmwiki` is rejected at the handler boundary so a stray value
 * doesn't silently fall through to the generic import path with a
 * cryptic file-shape error downstream.
 */
export async function runImportLlmwiki(ctx: CommandContext): Promise<ImportLlmwikiResult> {
  assertTypeLlmwiki(ctx);
  const exportPath = readExportPath(ctx);
  const dryRun = readBoolFlag(ctx, 'dry-run');

  const exportData = await loadOrThrow(exportPath);
  const projectId = resolveProjectId(ctx, exportData);

  // Dry-run short-circuits BEFORE adapter init so users can validate
  // an export without configuring an AM profile first.
  if (dryRun) {
    let totalBytes = 0;
    const dryRunPages = exportData.pages.map((p) => {
      const externalId = buildExternalId(projectId, p.pageDirectory, p.slug);
      const bodyBytes = Buffer.byteLength(p.body, 'utf-8');
      totalBytes += bodyBytes;
      return { path: p.path, externalId, bodyBytes };
    });
    return {
      created: [],
      updated: [],
      unchanged: [],
      dryRunPages,
      dryRunSummary: {
        pageCount: exportData.pages.length,
        totalBytes,
        projectId,
      },
    };
  }

  const scope = requireScope(ctx);
  const { adapter, capabilities } = await ctx.getAdapter();
  requireDynamicScope(ctx, 'ingest', capabilities);
  assertVerbatimSupported(capabilities);

  const warning = await ensureFirstImportOrOptedIn(adapter, scope, projectId, ctx);
  const result = await ingestPages(adapter, exportData, projectId, scope);
  const withWarning = warning !== undefined ? { ...result, warning } : result;
  if (withWarning.partialFailures && withWarning.partialFailures.length > 0) {
    // Surface partial-success outcomes prominently: throw with a
    // count summary so the CLI exits non-zero. Created memories are
    // still in the store (findable by externalId); the user sees
    // exactly how many pages failed and the first failure's message.
    const counts =
      `created ${withWarning.created.length}, failed ${withWarning.partialFailures.length}`;
    const first = withWarning.partialFailures[0]!;
    throw new CliError(
      'runtime',
      `Partial import: ${counts}. First failure on "${first.path}" (${first.externalId}): ${first.message}`,
    );
  }
  return withWarning;
}

/**
 * Concurrency note: the probe → ingest sequence is NOT atomic against
 * another process that imports the same `projectId` between the two
 * steps. A CI pipeline running parallel imports across workspaces, or
 * two team members importing the same wiki simultaneously, can each
 * see "first import, proceed" and write duplicate records. The
 * bridge assumes serial use; a follow-up advisory lock keyed on
 * `(user, projectId)` is the proper fix.
 */

function assertTypeLlmwiki(ctx: CommandContext): void {
  const value = ctx.flags.type;
  if (value !== TYPE_LLMWIKI) {
    throw new CliError(
      'usage',
      `--type must be "${TYPE_LLMWIKI}"; received "${String(value)}". ` +
        'Omit --type for the generic JSON-array import path.',
    );
  }
}

function readBoolFlag(ctx: CommandContext, name: string): boolean {
  return ctx.flags[name] === true;
}

function readExportPath(ctx: CommandContext): string {
  const target = ctx.positional[0];
  if (!target || target.length === 0) {
    throw new CliError('missing_input', 'import --type llmwiki requires a file path');
  }
  return target;
}

async function loadOrThrow(path: string): Promise<LLMWikiExport> {
  try {
    return await loadLLMWikiExport(path);
  } catch (cause) {
    if (cause instanceof LLMWikiBridgeError) {
      throw new CliError('usage', `${cause.code}: ${cause.message}`);
    }
    throw cause;
  }
}

function resolveProjectId(ctx: CommandContext, exportData: LLMWikiExport): string {
  const override = ctx.flags['project-id'] as string | undefined;
  try {
    return validateProjectId(override ?? exportData.projectId);
  } catch (cause) {
    if (cause instanceof LLMWikiBridgeError) {
      throw new CliError('missing_input', `${cause.code}: ${cause.message}`);
    }
    throw cause;
  }
}

function assertVerbatimSupported(capabilities: ProviderCapabilities): void {
  if (!supportsVerbatim(capabilities.ingestModes)) {
    throw new CliError(
      'unsupported_capability',
      `${E_LLMWIKI_VERBATIM_UNSUPPORTED}: ${verbatimUnsupportedMessage('<active provider>')}`,
    );
  }
}

async function ensureFirstImportOrOptedIn(
  adapter: ProviderAdapter,
  scope: CliScope,
  projectId: string,
  ctx: CommandContext,
): Promise<string | undefined> {
  const allowAppendOnly = readBoolFlag(ctx, 'allow-append-only');
  const acceptDuplicates = readBoolFlag(ctx, 'accept-duplicates');
  const yesFlag = readBoolFlag(ctx, 'yes');
  const probe = await probeForReimport(adapter, scope, projectId);

  if (probe.outcome === 'inconclusive') {
    throw new CliError(
      'usage',
      `${E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE}: walked ${probe.walked} memories without ` +
        'confirming first-import status. Bridge refuses to proceed because a re-import ' +
        'would silently duplicate every page. Reduce the memory set below 50,000, or ' +
        'supply a memory backend with a metadata-prefix list filter so the probe can ' +
        'complete in bounded work.',
    );
  }

  if (probe.outcome === 'none') return undefined;

  if (!(allowAppendOnly && acceptDuplicates)) {
    throw new CliError(
      'usage',
      `An import for projectId "${projectId}" already exists (found memory ${probe.id}). ` +
        'Re-running creates duplicates because AtomicMemory verbatim ingest is append-only. ' +
        'Each re-imported page becomes a NEW memory record with the FULL advisory metadata ' +
        '(body + tags + sources + citations + contradictions + aliases) — re-importing a ' +
        'large wiki can double the database size and pollute search ranking distribution ' +
        'since every query then returns parallel record pairs. ' +
        'Pass --allow-append-only AND --accept-duplicates to proceed.',
    );
  }
  if (!yesFlag) {
    throw new CliError(
      'usage',
      'Re-import with --allow-append-only requires explicit confirmation. ' +
        'Every page will be duplicated (body + full advisory metadata), and downstream ' +
        'search results will see N parallel record streams per page. ' +
        'Append --yes to acknowledge this.',
    );
  }
  return probe.sameNamespace
    ? undefined
    : `projectId "${projectId}" already exists under a DIFFERENT namespace ` +
        `(found memory ${probe.id}). projectId must be globally unique per user; ` +
        'duplicating across namespaces fragments the bridge identity.';
}

async function probeForReimport(
  adapter: ProviderAdapter,
  scope: CliScope,
  projectId: string,
): Promise<ReimportProbe> {
  const prefix = externalIdPrefixForProject(projectId);
  // Strip namespace / thread from the probe scope so a strict-filtering
  // adapter still surfaces prior imports made under a different namespace.
  // Without this, the cross-namespace warning path is dead on any adapter
  // that honors `ListRequest.scope.namespace` as a filter (which is the
  // common case). We rely on the adapter still scoping by user.
  const probeScope: CliScope = { user: scope.user };
  let cursor: string | undefined;
  let walked = 0;
  do {
    const page = await adapter.listMemories({
      scope: probeScope,
      limit: LIST_PAGE_SIZE,
      ...(cursor !== undefined && { cursor }),
    });
    for (const memory of page.memories) {
      if (matchesLlmwikiPrefix(memory, prefix)) {
        return {
          outcome: 'found',
          id: memory.id,
          sameNamespace: memory.scope.namespace === scope.namespace,
        };
      }
    }
    walked += page.memories.length;
    if (page.memories.length === 0) break; // adapter contract violation, but don't loop
    cursor = page.cursor;
    if (walked >= LIST_WALK_HARD_STOP) {
      return { outcome: 'inconclusive', walked };
    }
  } while (cursor !== undefined);
  return { outcome: 'none' };
}

/**
 * Match requires BOTH `provenance.source === "llmwiki"` AND the
 * externalId prefix. Two signals defeat the trivial bypass where a
 * user (or attacker with write access) crafts a custom memory with
 * a synthetic externalId to fake "already imported" state.
 */
function matchesLlmwikiPrefix(memory: AdapterMemorySummary, prefix: string): boolean {
  if (memory.provenance?.source !== 'llmwiki') return false;
  const externalId = readExternalId(memory.metadata);
  return typeof externalId === 'string' && externalId.startsWith(prefix);
}

function readExternalId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>).externalId;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Drive the ingest loop with per-page error collection so a failure
 * on page N does not throw away the N-1 successful writes that
 * preceded it. Failures land in `partialFailures` and the caller's
 * exit code reflects "any failure occurred", but we never silently
 * abandon partial state — the user always sees what actually got
 * ingested.
 */
async function ingestPages(
  adapter: ProviderAdapter,
  exportData: LLMWikiExport,
  projectId: string,
  scope: CliScope,
): Promise<ImportLlmwikiResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const partialFailures: { path: string; externalId: string; message: string }[] = [];
  for (const page of exportData.pages) {
    const input = buildIngestInput(page, projectId, scope);
    const externalId = (input.metadata as { externalId: string }).externalId;
    try {
      const result = await adapter.ingestMemories(input);
      created.push(...result.created);
      updated.push(...result.updated);
      unchanged.push(...result.unchanged);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      partialFailures.push({ path: page.path, externalId, message });
    }
  }
  return partialFailures.length > 0
    ? { created, updated, unchanged, partialFailures }
    : { created, updated, unchanged };
}

function buildIngestInput(page: ExportPage, projectId: string, scope: CliScope): AdapterIngestInput {
  const externalId = buildExternalId(projectId, page.pageDirectory, page.slug);
  return {
    mode: 'verbatim',
    scope,
    text: page.body,
    // `extractor: 'llmwiki'` is the SDK Provenance signal that this
    // content came from an external pipeline; complements
    // metadata.llmwiki.trustLevel ("external-import") which downstream
    // packagers also read.
    provenance: { source: 'llmwiki', sourceId: externalId, extractor: 'llmwiki' },
    metadata: {
      externalId,
      llmwiki: buildLlmwikiMetadata(page, projectId),
    },
  };
}
