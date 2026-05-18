/**
 * @file MCP tool definitions — memory_search, memory_ingest, memory_package, memory_list.
 *
 * Each tool declares its JSON Schema (via Zod) and a handler that
 * dispatches to `MemoryClient`. Scopes supplied by the caller override
 * the server-default scope loaded from config, so a single MCP server
 * can serve multiple users or namespaces when a plugin passes scope
 * explicitly per call.
 *
 * `sourceSite` routing: when a caller passes `sourceSite` on search /
 * package / list, the handler dispatches through `client.atomicmemory.*`
 * (the AtomicMemory-namespace handle natively supports sourceSite).
 * Without `sourceSite`, the V3 generic methods are used. If `sourceSite`
 * is set but the AtomicMemory namespace is unavailable (e.g. provider=mem0),
 * the handler throws PROVIDER_UNSUPPORTED instead of silently dropping
 * the filter.
 */

import type { MemoryClient } from '@atomicmemory/sdk';
import { z } from 'zod';
import type { Scope } from './config.js';

const ScopeArg = z
  .object({
    user: z.string().optional(),
    agent: z.string().optional(),
    namespace: z.string().optional(),
    thread: z.string().optional(),
  })
  .strict();

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(JsonValue)]),
);

const MetadataArg = z.record(JsonValue);

const ProvenanceArg = z
  .object({
    source: z.string().optional(),
    sourceUrl: z.string().optional(),
    sourceId: z.string().optional(),
    extractor: z.string().optional(),
  })
  .strict();

export const SearchArgsSchema = z
  .object({
    query: z.string().min(1),
    scope: ScopeArg.optional(),
    limit: z.number().int().positive().max(100).optional(),
    sourceSite: z.string().min(1).optional(),
  })
  .strict();

export const IngestArgsSchema = z
  .object({
    mode: z.enum(['text', 'messages', 'verbatim']),
    content: z.string().optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant', 'system', 'tool']),
          content: z.string(),
        }),
      )
      .optional(),
    scope: ScopeArg.optional(),
    metadata: MetadataArg.optional(),
    provenance: ProvenanceArg.optional(),
    kind: z.enum(['fact', 'episode', 'summary', 'procedure', 'document']).optional(),
  })
  .strict();

export const PackageArgsSchema = z
  .object({
    query: z.string().min(1),
    scope: ScopeArg.optional(),
    tokenBudget: z.number().int().positive().optional(),
    sourceSite: z.string().min(1).optional(),
  })
  .strict();

export const ListArgsSchema = z
  .object({
    scope: ScopeArg.optional(),
    limit: z.number().int().positive().max(100).optional(),
    sourceSite: z.string().min(1).optional(),
  })
  .strict();

export type SearchArgs = z.infer<typeof SearchArgsSchema>;
export type IngestArgs = z.infer<typeof IngestArgsSchema>;
export type PackageArgs = z.infer<typeof PackageArgsSchema>;
type ListArgs = z.infer<typeof ListArgsSchema>;

/**
 * Build tool handlers bound to a specific MemoryClient + default scope.
 */
export function createHandlers(client: MemoryClient, defaultScope: Scope | undefined) {
  return {
    memory_search: (args: SearchArgs) => {
      const scope = mergeScope(defaultScope, args.scope);
      if (args.sourceSite) {
        return atomicmemoryNamespace(client).search(
          {
            query: args.query,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            sourceSite: args.sourceSite,
          },
          toUserMemoryScope(scope, 'sourceSite'),
        );
      }
      return client.search({
        query: args.query,
        scope,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      } as Parameters<MemoryClient['search']>[0]);
    },

    memory_ingest: (args: IngestArgs) =>
      args.mode === 'verbatim'
        ? ingestVerbatim(client, args, defaultScope)
        : client.ingest(buildIngestInput(args, defaultScope)),

    memory_package: (args: PackageArgs) => {
      const scope = mergeScope(defaultScope, args.scope);
      if (args.sourceSite) {
        // AtomicMemory namespace's `search` with retrievalMode=tiered + tokenBudget
        // is the package-equivalent path that supports sourceSite — `client.atomicmemory`
        // does not expose a separate `package(...)` method. The response shape is
        // `AtomicMemorySearchResultPage` (count, results, injectionText, citations,
        // estimatedContextTokens). `skipRepair: true` matches the v1 package call
        // and avoids invoking the AUDN repair pass on a packaging read.
        return atomicmemoryNamespace(client).search(
          {
            query: args.query,
            retrievalMode: 'tiered',
            skipRepair: true,
            ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
            sourceSite: args.sourceSite,
          },
          toUserMemoryScope(scope, 'sourceSite'),
        );
      }
      return client.package({
        query: args.query,
        scope,
        ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
      } as Parameters<MemoryClient['package']>[0]);
    },

    memory_list: (args: ListArgs) => {
      const scope = mergeScope(defaultScope, args.scope);
      if (args.sourceSite) {
        return atomicmemoryNamespace(client).list(
          toUserMemoryScope(scope, 'sourceSite'),
          {
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            sourceSite: args.sourceSite,
          },
        );
      }
      return client.list({
        scope,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      } as Parameters<MemoryClient['list']>[0]);
    },
  };
}

/**
 * Pick the AtomicMemory namespace handle off the client, or throw a typed
 * PROVIDER_UNSUPPORTED error if it's unavailable.
 *
 * Used by the sourceSite-routing branches: a `sourceSite` filter is meaningless
 * for non-AtomicMemory providers, so failing loudly is preferred over silently
 * dropping the filter and returning unfiltered memories.
 */
function atomicmemoryNamespace(client: MemoryClient): NonNullable<MemoryClient['atomicmemory']> {
  const handle = client.atomicmemory;
  if (!handle) {
    const err = new Error(
      'sourceSite requires the AtomicMemory provider; the active client has no `atomicmemory` namespace',
    ) as Error & { code?: string };
    err.code = 'PROVIDER_UNSUPPORTED';
    throw err;
  }
  return handle;
}

/**
 * Convert a V3 generic `Scope` to AtomicMemory's user-scope `MemoryScope`.
 * sourceSite is user-scope only on AtomicMemory's list/search routes per
 * `atomicmemory-sdk/src/memory/atomicmemory-provider/handle-impl.ts:122-127`,
 * so callers reaching the sourceSite path must have a user-id present.
 */
function toUserMemoryScope(scope: Scope, feature: string): { kind: 'user'; userId: string } {
  if (!scope.user) {
    throw new Error(`${feature} requires scope.user`);
  }
  return { kind: 'user', userId: scope.user };
}

function mergeScope(base: Scope | undefined, override: Scope | undefined): Scope {
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  if (!merged.user && !merged.agent && !merged.namespace && !merged.thread) {
    throw new Error(
      'scope required: provide at least one of user, agent, namespace, thread',
    );
  }
  return merged;
}

function buildIngestInput(
  args: IngestArgs,
  defaultScope: Scope | undefined,
): Parameters<MemoryClient['ingest']>[0] {
  const scope = mergeScope(defaultScope, args.scope);
  if (args.mode === 'text') {
    if (!args.content) throw new Error('content required when mode=text');
    return {
      mode: 'text',
      content: args.content,
      scope,
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      ...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
    } as Parameters<MemoryClient['ingest']>[0];
  }
  if (args.mode === 'messages') {
    if (!args.messages?.length) throw new Error('messages required when mode=messages');
    return {
      mode: 'messages',
      messages: args.messages,
      scope,
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      ...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
    } as Parameters<MemoryClient['ingest']>[0];
  }
  throw new Error(`unsupported ingest mode for extraction path: ${args.mode}`);
}

async function ingestVerbatim(
  client: MemoryClient,
  args: IngestArgs,
  defaultScope: Scope | undefined,
): Promise<unknown> {
  const scope = mergeScope(defaultScope, args.scope);
  if (!args.content) throw new Error('content required when mode=verbatim');

  const callerMetadata: Record<string, unknown> = args.metadata ?? {};
  const dedupeKey =
    typeof callerMetadata.dedupe_key === 'string'
      ? callerMetadata.dedupe_key
      : undefined;
  const source = args.provenance?.source ?? 'mcp';
  const sourceUrl =
    args.provenance?.sourceUrl ??
    (dedupeKey ? `atomicmemory://mcp/verbatim/${dedupeKey}` : '');

  // Explicit guard: only AtomicMemory provider supports the
  // verbatim+quick path with metadata persistence today. The SDK's
  // capability gate (only providers with `'verbatim'` in
  // `capabilities().ingestModes` accept the mode) eventually rejects
  // non-AtomicMemory + verbatim, but the SDK error wording isn't
  // MCP-specific. This guard fails fast with a message that points
  // the caller at provider configuration, not SDK internals.
  if (!client.atomicmemory) {
    throw new Error('mode=verbatim requires the AtomicMemory provider');
  }
  if (!scope.user) {
    throw new Error(
      'mode=verbatim requires scope.user for AtomicMemory quick ingest',
    );
  }

  // Forward via the generic `client.ingest` path so caller-supplied
  // `args.metadata` reaches core's `/v1/memories/ingest/quick` route.
  // The AtomicMemory provider's HTTP body builder now wires the
  // metadata field through (atomicmemory-sdk PR #15); the namespaced
  // `client.atomicmemory.ingestQuick(...)` handle's options-arg type
  // is `{ skipExtraction?: boolean }` only, so its options bag has
  // no metadata slot.
  //
  // Core honors metadata only on the verbatim+quick branch with no
  // workspace context (atomicmemory-core PR #51); reserved keys
  // (cmo_id, headline, memberMemoryIds, ...) are rejected with 400.
  return client.ingest({
    mode: 'verbatim',
    content: args.content,
    scope: { user: scope.user },
    provenance: { source, sourceUrl },
    metadata: callerMetadata,
  });
}
