/**
 * @file `atomicmemory init` — write or update a named profile.
 *
 * v5 contract:
 *   - bare `init` with no profiles bootstraps "default"
 *   - --profile <name> persists flags into that named profile
 *   - --force overwrites populated fields; without --force,
 *     non-interactive init fails before overwriting populated fields
 *   - --api-key-stdin reads the key from stdin; persisted only when
 *     paired with --save-api-key (otherwise consumed for one-shot
 *     validation and discarded)
 *   - plain --api-key is rejected upstream by rejectPlainApiKeyFlag
 *   - new profiles require an explicit trust surface from
 *     --trust-surface or ATOMICMEMORY_TRUST_SURFACE
 *
 * This command does not initialize a provider; it only persists config.
 */

import { CliError, type CliScopePartial } from '../../types.js';
import {
  emptyConfig,
  type CliProfileShape,
  type CliConfigShape,
} from '../../config/schema.js';
import { addProfile, saveConfig } from '../../config/profiles.js';
import { ensureConfigDir } from '../../config/permissions.js';
import { shouldPersistInitKey } from '../../config/api-key.js';
import type { CommandHandler } from '../types.js';

export const init: CommandHandler<{
  profile: string;
  written: boolean;
  apiKeyPersisted: boolean;
}> = async (ctx) => {
  const profileName =
    typeof ctx.flags.profile === 'string' && ctx.flags.profile.length > 0
      ? ctx.flags.profile
      : ctx.config.activeProfile || 'default';

  const baseConfig: CliConfigShape =
    Object.keys(ctx.config.profiles).length > 0 ? ctx.config : emptyConfig();
  const force = ctx.flags.force === true;

  // Single shared stdin read: ctx.readStdin() is cached at the bin
  // level so re-reading here returns the same buffered key. bin.ts
  // already overlaid this onto ctx.profile.apiKey for adapter use; we
  // only re-fetch it here to decide persistence.
  let stdinKey: string | undefined;
  if (ctx.flags['api-key-stdin'] === true) {
    const piped = (await ctx.readStdin()).trim();
    if (piped.length === 0) {
      throw new CliError('missing_input', '--api-key-stdin received no input');
    }
    stdinKey = piped;
  }
  const persistKey = shouldPersistInitKey({
    hasStdinKey: stdinKey !== undefined,
    saveApiKey: ctx.flags['save-api-key'] === true,
  });

  const profile: CliProfileShape = buildProfile(ctx, baseConfig, profileName, persistKey ? stdinKey : undefined);
  const next = addProfile(baseConfig, profileName, profile, { force });

  // Bootstrap activeProfile when the config is fresh.
  if (Object.keys(baseConfig.profiles).length === 0) {
    next.activeProfile = profileName;
  }

  ensureConfigDir(ctx.configDir);
  saveConfig(ctx.configPath, ctx.configDir, next);

  return {
    command: 'init',
    data: {
      profile: profileName,
      written: true,
      apiKeyPersisted: persistKey,
    },
    count: 1,
    meta: { profilesTotal: Object.keys(next.profiles).length },
  };
};

function buildProfile(
  ctx: import('../types.js').CommandContext,
  base: CliConfigShape,
  name: string,
  apiKey: string | undefined,
): CliProfileShape {
  const existing = base.profiles[name];
  const provider =
    (ctx.flags.provider as 'atomicmemory' | 'mem0' | undefined) ??
    existing?.provider ??
    'atomicmemory';
  const apiUrl = resolveInitApiUrl(ctx, existing, name);
  const trustSurface = resolveInitTrustSurface(ctx, existing, name);
  const scope = mergeInitScope(ctx, existing);

  const profile: CliProfileShape = { provider, apiUrl, trustSurface };
  if (Object.keys(scope).length > 0) profile.scope = scope;
  if (apiKey) profile.apiKey = apiKey;
  if (existing?.output) profile.output = existing.output;
  return profile;
}

/**
 * v5: required config has no implicit default. Fail before writing when
 * no apiUrl can be sourced (flag > env > existing profile). Bootstrapping
 * a brand-new profile MUST receive --api-url or ATOMICMEMORY_API_URL.
 */
function resolveInitApiUrl(
  ctx: import('../types.js').CommandContext,
  existing: CliProfileShape | undefined,
  name: string,
): string {
  const flagApiUrl =
    typeof ctx.flags['api-url'] === 'string' && ctx.flags['api-url'].length > 0
      ? (ctx.flags['api-url'] as string)
      : undefined;
  const envApiUrl =
    typeof ctx.env.ATOMICMEMORY_API_URL === 'string' &&
    ctx.env.ATOMICMEMORY_API_URL.length > 0
      ? ctx.env.ATOMICMEMORY_API_URL
      : undefined;
  const apiUrl = flagApiUrl ?? envApiUrl ?? existing?.apiUrl;
  if (!apiUrl) {
    throw new CliError(
      'missing_input',
      `init for new profile "${name}" requires --api-url <url> or ` +
        'ATOMICMEMORY_API_URL; refusing to write a hardcoded provider default',
    );
  }
  return apiUrl;
}

function resolveInitTrustSurface(
  ctx: import('../types.js').CommandContext,
  existing: CliProfileShape | undefined,
  name: string,
): CliProfileShape['trustSurface'] {
  const candidate =
    readTrustSurface(ctx.flags['trust-surface'], '--trust-surface') ??
    readTrustSurface(ctx.env.ATOMICMEMORY_TRUST_SURFACE, 'ATOMICMEMORY_TRUST_SURFACE') ??
    existing?.trustSurface;
  if (candidate) return candidate;
  throw new CliError(
    'missing_input',
    `init for new profile "${name}" requires --trust-surface or ` +
      'ATOMICMEMORY_TRUST_SURFACE; refusing to write a hardcoded trust default',
  );
}

function readTrustSurface(
  value: unknown,
  source: string,
): CliProfileShape['trustSurface'] | undefined {
  if (
    value === 'local' ||
    value === 'self-hosted' ||
    value === 'authenticated-wrapper'
  ) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    throw new CliError(
      'usage',
      `${source} must be local|self-hosted|authenticated-wrapper; got "${value}"`,
    );
  }
  return undefined;
}

function mergeInitScope(
  ctx: import('../types.js').CommandContext,
  existing: CliProfileShape | undefined,
): CliScopePartial {
  const scope: CliScopePartial = { ...(existing?.scope ?? {}) };
  if (typeof ctx.flags.user === 'string') scope.user = ctx.flags.user;
  if (typeof ctx.flags['agent-id'] === 'string') scope.agent_id = ctx.flags['agent-id'];
  if (typeof ctx.flags.namespace === 'string') scope.namespace = ctx.flags.namespace;
  if (typeof ctx.flags.thread === 'string') scope.thread = ctx.flags.thread;
  return scope;
}
