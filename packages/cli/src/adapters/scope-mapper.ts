/**
 * @file Bidirectional translation between the CLI's canonical scope
 * (agent_id) and the SDK's scope (agent). The split lives here so the
 * rest of the adapter does not have to remember which side names which
 * field.
 *
 * For capabilities: SDK `requiredScope` entries name SDK fields
 * (including `agent`); the mapper rewrites every entry — including the
 * `default` fallback — into CLI field names. Phase 3's
 * `assertDynamicScope` already honors `requiredScope.default` when an
 * operation-specific entry is absent.
 *
 * SDK imports are confined to this module (and its sibling adapters) so
 * the AST containment scan stays green.
 */

import type {
  Capabilities as SdkCapabilities,
  Memory as SdkMemory,
  Provenance as SdkProvenance,
  Scope as SdkScope,
} from '@atomicmemory/sdk';
import { CliError, type CliScope, type ProviderCapabilities } from '../types.js';
import type {
  AdapterMemoryKind,
  AdapterMemorySummary,
  AdapterProvenance,
} from './types.js';

/** Translate CLI canonical scope to the SDK shape. agent_id -> agent. */
export function cliScopeToSdkScope(scope: CliScope): SdkScope {
  const sdk: SdkScope = { user: scope.user };
  if (scope.agent_id) sdk.agent = scope.agent_id;
  if (scope.namespace) sdk.namespace = scope.namespace;
  if (scope.thread) sdk.thread = scope.thread;
  return sdk;
}

/**
 * Translate the SDK scope of a memory back to CLI canonical fields.
 * `user` is required by the v5 CliScope contract; if the SDK/provider
 * returns a scope without a `user`, this function fails closed by
 * throwing CliError('runtime'). Synthesizing `user: ''` would let
 * malformed provider responses propagate into renderers and downstream
 * tooling silently — better to surface the protocol violation as a
 * runtime error so the operator sees the real problem.
 */
export function sdkScopeToCliScope(scope: SdkScope | undefined): CliScope {
  if (!scope || typeof scope.user !== 'string' || scope.user.length === 0) {
    throw new CliError(
      'runtime',
      'provider returned memory without scope.user',
    );
  }
  const out: CliScope = { user: scope.user };
  if (scope.agent) out.agent_id = scope.agent;
  if (scope.namespace) out.namespace = scope.namespace;
  if (scope.thread) out.thread = scope.thread;
  return out;
}

/**
 * Translate SDK Capabilities to the CLI's ProviderCapabilities shape.
 * Every `requiredScope` entry (including the mandatory `default`) is
 * mapped from SDK field names to CLI field names so callers can
 * assertDynamicScope against `agent_id`, not `agent`.
 */
export function sdkCapabilitiesToCli(caps: SdkCapabilities): ProviderCapabilities {
  const requiredScope: Record<string, Array<keyof CliScope>> = {};
  for (const [op, fields] of Object.entries(caps.requiredScope)) {
    if (!fields) continue;
    requiredScope[op] = fields.map(sdkScopeFieldToCli);
  }

  return {
    ingestModes: caps.ingestModes,
    requiredScope,
    extensions: { ...caps.extensions },
    ...(caps.maxTokenBudget !== undefined
      ? { maxTokenBudget: caps.maxTokenBudget }
      : {}),
    ...(caps.supportedRerankers
      ? { supportedRerankers: caps.supportedRerankers }
      : {}),
    ...(caps.supportedFilterOps
      ? { supportedFilterOps: caps.supportedFilterOps }
      : {}),
    ...(caps.customExtensions ? { customExtensions: caps.customExtensions } : {}),
  };
}

export function sdkScopeFieldToCli(field: keyof SdkScope): keyof CliScope {
  switch (field) {
    case 'agent':
      return 'agent_id';
    case 'user':
    case 'namespace':
    case 'thread':
      return field;
  }
}

/**
 * Translate an SDK Memory record to the CLI's AdapterMemorySummary
 * shape. The SDK's `kind` is forwarded as-is; the CLI restricts kinds
 * to the v5 enum.
 */
export function sdkMemoryToCli(memory: SdkMemory): AdapterMemorySummary {
  const summary: AdapterMemorySummary = {
    id: memory.id,
    content: memory.content,
    scope: sdkScopeToCliScope(memory.scope),
    createdAt:
      memory.createdAt instanceof Date
        ? memory.createdAt.toISOString()
        : String(memory.createdAt),
  };
  if (memory.kind) {
    summary.kind = memory.kind as AdapterMemoryKind;
  }
  if (memory.updatedAt) {
    summary.updatedAt =
      memory.updatedAt instanceof Date
        ? memory.updatedAt.toISOString()
        : String(memory.updatedAt);
  }
  if (memory.metadata) summary.metadata = memory.metadata;
  if (memory.provenance) {
    summary.provenance = sdkProvenanceToCli(memory.provenance);
  }
  return summary;
}

export function sdkProvenanceToCli(p: SdkProvenance): AdapterProvenance {
  const out: AdapterProvenance = {};
  if (p.source) out.source = p.source;
  if (p.sourceUrl) out.sourceUrl = p.sourceUrl;
  if (p.sourceId) out.sourceId = p.sourceId;
  if (p.extractor) out.extractor = p.extractor;
  return out;
}

export function cliProvenanceToSdk(p: AdapterProvenance): SdkProvenance {
  const out: SdkProvenance = {};
  if (p.source) out.source = p.source;
  if (p.sourceUrl) out.sourceUrl = p.sourceUrl;
  if (p.sourceId) out.sourceId = p.sourceId;
  if (p.extractor) out.extractor = p.extractor;
  return out;
}
