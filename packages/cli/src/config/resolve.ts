/**
 * @file Flag/env/profile precedence resolution and the two-stage scope
 * helpers consumed by `lifecycle.ts`. Per v5 §"Scope":
 *
 *   - flags > env > active profile config (precedence)
 *   - static stage runs before adapter init: missing required `user`
 *     throws CliError('missing_user') (exit 2)
 *   - dynamic stage runs after `getCapabilities()` resolves but before
 *     the operation: missing fields named in `Capabilities.requiredScope`
 *     throw CliError('missing_scope_field') (exit 2)
 *
 * No SDK imports here — capabilities are passed in as a plain shape so
 * the AST scan remains green.
 */

import {
  CliError,
  type CliScope,
  type CliScopePartial,
  type ProviderCapabilities,
} from '../types.js';

interface ResolveScopeFlags {
  user?: string;
  agentId?: string;
  namespace?: string;
  thread?: string;
}

interface ResolveScopeInputs {
  /**
   * Persisted profile.scope, when a profile is configured. Optional —
   * scope still resolves from flags + env when no profile exists, so
   * we never have to synthesize a fake provider/apiUrl object just to
   * satisfy a parameter signature.
   */
  profileScope?: CliScopePartial;
  flags: ResolveScopeFlags;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the effective scope for the current command from
 *   flags > env > profile.scope
 * Empty/missing values at any layer fall through to the next layer.
 */
export function resolveScope(inputs: ResolveScopeInputs): CliScopePartial {
  const fromProfile = inputs.profileScope ?? {};
  const fromEnv = stripUndefined({
    user: cleanEnv(inputs.env.ATOMICMEMORY_SCOPE_USER),
    agent_id: cleanEnv(inputs.env.ATOMICMEMORY_SCOPE_AGENT_ID),
    namespace: cleanEnv(inputs.env.ATOMICMEMORY_SCOPE_NAMESPACE),
    thread: cleanEnv(inputs.env.ATOMICMEMORY_SCOPE_THREAD),
  });
  const fromFlags = stripUndefined({
    user: nonEmpty(inputs.flags.user),
    agent_id: nonEmpty(inputs.flags.agentId),
    namespace: nonEmpty(inputs.flags.namespace),
    thread: nonEmpty(inputs.flags.thread),
  });
  return { ...fromProfile, ...fromEnv, ...fromFlags };
}

interface StaticScopeRequirement {
  /** Whether this command requires `user` before provider init. */
  requireUser: boolean;
}

/**
 * Static stage: runs after flag/env/profile resolution and BEFORE
 * adapter init. Catches the most common failure (no user resolvable
 * for any source) so we never pay the cost of provider construction
 * for a deterministic validation failure.
 */
export function assertStaticScope(
  scope: CliScopePartial,
  requirement: StaticScopeRequirement,
): void {
  if (!requirement.requireUser) return;
  if (!scope.user || scope.user.length === 0) {
    throw new CliError(
      'missing_user',
      'no user resolved; pass --user, set ATOMICMEMORY_SCOPE_USER, or run `atomicmemory init` to persist one in a profile',
    );
  }
}

/**
 * Dynamic stage: runs AFTER `getCapabilities()` resolves but BEFORE the
 * operation runs. Some providers/operations require additional scope
 * fields beyond `user` (per `Capabilities.requiredScope`). Missing
 * fields throw `missing_scope_field` (exit 2).
 *
 * Resolution: an operation-specific entry under `requiredScope` wins
 * when present; otherwise the provider's `requiredScope.default` entry
 * is consulted. This lets a provider declare a uniform scope contract
 * once and override per-operation only where the rules differ.
 */
export function assertDynamicScope(
  scope: CliScopePartial,
  operationName: string,
  capabilities: ProviderCapabilities,
): void {
  const required = resolveRequiredScope(capabilities, operationName);
  if (!required || required.length === 0) return;

  for (const field of required) {
    const value = scope[field as keyof CliScopePartial];
    if (value == null || value.length === 0) {
      // user-level misses should already have been caught statically;
      // if we reach here it's a bug, but classify accurately for callers.
      const code =
        field === 'user' ? 'missing_user' : 'missing_scope_field';
      throw new CliError(
        code,
        `provider requires scope.${String(field)} for "${operationName}"`,
      );
    }
  }
}

function resolveRequiredScope(
  capabilities: ProviderCapabilities,
  operationName: string,
): Array<keyof CliScopePartial> | undefined {
  const map = capabilities.requiredScope;
  if (!map) return undefined;
  const explicit = map[operationName];
  if (explicit !== undefined) return explicit as Array<keyof CliScopePartial>;
  const fallback = map.default;
  if (fallback !== undefined) return fallback as Array<keyof CliScopePartial>;
  return undefined;
}

/**
 * Map the resolved partial scope onto a complete `CliScope` after
 * static validation has confirmed `user` is present. Used by the
 * lifecycle once it has called `assertStaticScope({ requireUser: true })`.
 */
export function intoCliScope(scope: CliScopePartial): CliScope {
  if (!scope.user) {
    throw new CliError(
      'missing_user',
      'intoCliScope called before assertStaticScope({ requireUser: true })',
    );
  }
  const out: CliScope = { user: scope.user };
  if (scope.agent_id) out.agent_id = scope.agent_id;
  if (scope.namespace) out.namespace = scope.namespace;
  if (scope.thread) out.thread = scope.thread;
  return out;
}

function cleanEnv(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]?: NonNullable<T[K]> };
}
