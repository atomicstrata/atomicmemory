/**
 * @file Profile resolution with v5 precedence: flags > env > config.
 *
 * Per v5 §"Config + named profiles": there is no synthetic fallback
 * profile. Either a profile is configured, or flags/env supply
 * provider+apiUrl directly. Otherwise return null and let
 * provider-touching commands surface the failure via getAdapter().
 *
 * Env vars override persisted profile fields (provider/apiUrl) too —
 * not just flags. Phase 5 audit caught this gap; it is fixed here.
 */

import { mergeNonInitOverlay } from '../config/profiles.js';
import type {
  CliConfigShape,
  CliProfileShape,
} from '../config/schema.js';
import { CliError, type CliScopePartial, type OutputMode } from '../types.js';
import type { CommandFlags } from '../commands/types.js';

/**
 * Build a base profile from the persisted config plus env-level
 * overrides. Returns null when neither a profile nor sufficient
 * flag/env config exists; callers that need provider access throw
 * `usage` from `ctx.getAdapter()` in that case.
 */
export function resolveBaseProfile(
  flags: CommandFlags,
  config: CliConfigShape,
  profileName: string,
  env: NodeJS.ProcessEnv,
): CliProfileShape | null {
  const persisted = config.profiles[profileName];

  // Effective provider/apiUrl: flags > env > persisted.
  const provider = pick(
    flags.provider,
    env.ATOMICMEMORY_PROVIDER,
    persisted?.provider,
  );
  const apiUrl = pick(
    flags['api-url'],
    env.ATOMICMEMORY_API_URL,
    persisted?.apiUrl,
  );

  // Without provider+apiUrl from any source we cannot construct a
  // profile. That is the v5 "fail deterministically" path; callers
  // with non-provider intent (init, version, help, ...) tolerate
  // null.
  if (
    (provider !== 'atomicmemory' && provider !== 'mem0') ||
    typeof apiUrl !== 'string' ||
    apiUrl.length === 0
  ) {
    return null;
  }

  const trustSurface = resolveTrustSurface(flags, env, persisted);

  const base: CliProfileShape = {
    provider,
    apiUrl,
    trustSurface,
  };
  if (persisted?.scope) base.scope = persisted.scope;
  if (persisted?.output) base.output = persisted.output;
  if (persisted?.apiKey) base.apiKey = persisted.apiKey;
  return base;
}

/**
 * Apply the non-init overlay onto a base profile. Phase 3's
 * `mergeNonInitOverlay` does the heavy lifting; this helper just
 * shapes the overlay object from the parsed flags.
 */
function buildOverlay(
  flags: CommandFlags,
): {
  provider?: CliProfileShape['provider'];
  apiUrl?: string;
  output?: OutputMode;
  scope?: CliScopePartial;
} {
  const overlayScope: CliScopePartial = {};
  if (typeof flags.user === 'string') overlayScope.user = flags.user;
  if (typeof flags['agent-id'] === 'string')
    overlayScope.agent_id = flags['agent-id'];
  if (typeof flags.namespace === 'string')
    overlayScope.namespace = flags.namespace;
  if (typeof flags.thread === 'string') overlayScope.thread = flags.thread;

  const overlay: ReturnType<typeof buildOverlay> = {};
  if (typeof flags.provider === 'string') {
    overlay.provider = flags.provider as CliProfileShape['provider'];
  }
  if (typeof flags['api-url'] === 'string') {
    overlay.apiUrl = flags['api-url'];
  }
  if (typeof flags.output === 'string') {
    overlay.output = flags.output as OutputMode;
  }
  if (Object.keys(overlayScope).length > 0) overlay.scope = overlayScope;
  return overlay;
}

export function applyOverlay(
  base: CliProfileShape,
  flags: CommandFlags,
): CliProfileShape {
  return mergeNonInitOverlay(base, buildOverlay(flags));
}

function pick<T>(...candidates: Array<T | undefined>): T | undefined {
  for (const c of candidates) {
    if (typeof c === 'string') {
      if (c.trim().length > 0) return c as T;
      continue;
    }
    if (c !== undefined) return c;
  }
  return undefined;
}

function resolveTrustSurface(
  flags: CommandFlags,
  env: NodeJS.ProcessEnv,
  persisted: CliProfileShape | undefined,
): CliProfileShape['trustSurface'] {
  const candidate = pick(
    flags['trust-surface'],
    env.ATOMICMEMORY_TRUST_SURFACE,
    persisted?.trustSurface,
  );
  if (
    candidate === 'local' ||
    candidate === 'self-hosted' ||
    candidate === 'authenticated-wrapper'
  ) {
    return candidate;
  }
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    throw new CliError(
      'missing_input',
      `invalid trust surface "${candidate}"; expected local|self-hosted|authenticated-wrapper`,
    );
  }
  throw new CliError(
    'missing_input',
    'explicit trust surface is required when using provider/apiUrl without a saved profile',
  );
}
