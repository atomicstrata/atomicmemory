/**
 * @file Scope mapper for the AtomicMemory namespace
 *
 * Serializes the AtomicMemory-specific `MemoryScope` discriminated union
 * to the HTTP params atomicmemory-core's routes expect. Matches
 * `parseOptionalWorkspaceContext` at
 * `atomicmemory-core/src/routes/memories.ts:601-614`.
 */

import type { AgentScope, MemoryScope } from './handle';

/**
 * Body/query fields derived from a `MemoryScope`.
 * - user scope → `{ user_id }`
 * - workspace scope → `{ user_id, workspace_id, agent_id, agent_scope? }`
 *
 * `agent_scope` mirrors core's parser acceptance
 * (atomicmemory-core/src/routes/memories.ts:617-627): one of the canonical
 * strings, an arbitrary agent_id string, or an array of agent IDs.
 */
interface ScopeFields {
  user_id: string;
  workspace_id?: string;
  agent_id?: string;
  agent_scope?: AgentScope;
  session_id?: string;
}

interface ScopeSerializeOptions {
  /**
   * Emit `agent_scope` on the wire. Only useful on `POST /memories/search`
   * and `POST /memories/search/fast` — core explicitly ignores
   * `agent_scope` on expand/list/get/delete (memories.ts:216, 231, 436,
   * 460), so sending it there would be a silent no-op that misleads
   * callers into thinking workspace filtering is active.
   *
   * Defaults to `false`. Search route bindings opt in explicitly.
   */
  includeAgentScope?: boolean;
  /**
   * Emit `session_id` on the wire. Core honors this on ingest, search, and
   * list. Routes such as get/delete/expand do not filter by session, so they
   * must not send or echo it.
   */
  includeThread?: boolean;
}

export function scopeToFields(
  scope: MemoryScope,
  options: ScopeSerializeOptions = {},
): ScopeFields {
  if (scope.kind === 'user') {
    const fields: ScopeFields = { user_id: scope.userId };
    if (options.includeThread && scope.thread) {
      fields.session_id = scope.thread;
    }
    return fields;
  }
  const fields: ScopeFields = {
    user_id: scope.userId,
    workspace_id: scope.workspaceId,
    agent_id: scope.agentId,
  };
  if (options.includeAgentScope && scope.agentScope !== undefined) {
    fields.agent_scope = scope.agentScope;
  }
  if (options.includeThread && scope.thread) {
    fields.session_id = scope.thread;
  }
  return fields;
}

/**
 * URLSearchParams-ready variant for GET/DELETE routes that accept scope
 * via query string. Defaults to NOT sending `agent_scope` — the only
 * routes that honor it are search routes (POST /memories/search[/fast]),
 * which use bodies, not query strings. Pass `includeAgentScope: true`
 * only if you have a specific reason.
 */
export function scopeToQueryParams(
  scope: MemoryScope,
  options: ScopeSerializeOptions = {},
): URLSearchParams {
  const params = new URLSearchParams();
  const fields = scopeToFields(scope, options);
  params.set('user_id', fields.user_id);
  if (fields.workspace_id) params.set('workspace_id', fields.workspace_id);
  if (fields.agent_id) params.set('agent_id', fields.agent_id);
  if (fields.agent_scope !== undefined) {
    // Core accepts agent_scope as either a single string or a repeated query
    // param for arrays (memories.ts:617-627). Serialize accordingly.
    if (Array.isArray(fields.agent_scope)) {
      for (const value of fields.agent_scope) {
        params.append('agent_scope', value);
      }
    } else {
      params.set('agent_scope', fields.agent_scope);
    }
  }
  if (fields.session_id) params.set('session_id', fields.session_id);
  return params;
}

/**
 * Reject combinations core rejects. Call from methods before issuing HTTP.
 *
 * Today this only guards user-scope + visibility on ingest — an invalid
 * combination because visibility is a workspace-only write-time label
 * (see parseOptionalWorkspaceContext at memories.ts:601-614).
 */
export function assertScopeAllowsVisibility(
  scope: MemoryScope,
  visibility: string | undefined,
): void {
  if (visibility !== undefined && scope.kind !== 'workspace') {
    throw new Error(
      'ingest `visibility` is only valid with workspace scope; '
        + 'omit it or use a workspace scope variant.',
    );
  }
}

/**
 * Strip `agentScope` from a `MemoryScope` for routes that do NOT honor
 * agent_scope on the backend. Used to
 * echo scope back on returned memories honestly — so a caller who
 * passed `{ agentScope: 'self' }` does not receive memories whose
 * `.scope.agentScope` field implies the filter was applied when it
 * wasn't.
 *
 * User-scope passes through unchanged.
 */
export function stripAgentScope(scope: MemoryScope): MemoryScope {
  if (scope.kind !== 'workspace') return scope;
  const stripped: MemoryScope = {
    kind: 'workspace',
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    agentId: scope.agentId,
    ...(scope.thread !== undefined ? { thread: scope.thread } : {}),
  };
  return stripped;
}

/**
 * Strip filters that the target route did not apply before echoing scope onto
 * returned memories. Search/list can preserve thread because Core applies the
 * filter and projects `session_id`; expand/get/delete cannot.
 */
export function stripReadFilters(scope: MemoryScope): MemoryScope {
  if (scope.kind === 'user') {
    return { kind: 'user', userId: scope.userId };
  }
  return {
    kind: 'workspace',
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    agentId: scope.agentId,
  };
}
