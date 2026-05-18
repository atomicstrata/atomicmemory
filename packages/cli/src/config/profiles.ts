/**
 * @file Named-profile load/save/list/use/show/add and ephemeral overlay
 * helpers. Per v5 §"Profiles":
 *
 *   - schema_version "2", activeProfile pointer, profiles record.
 *   - Bare `init` with no profiles bootstraps "default".
 *   - `init --profile <name>` persists flags into that named profile.
 *   - `--force` overwrites populated fields; without it, populated fields
 *     are protected (interactive init prompts; non-interactive throws).
 *   - Non-init flags are ephemeral overlays — `mergeNonInitOverlay`
 *     produces a transient view without touching disk.
 *
 * Filesystem permission enforcement lives in `permissions.ts`. This
 * module owns the JSON shape transformations only.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CliConfigSchema,
  emptyConfig,
  type CliConfigShape,
  type CliProfileShape,
} from './schema.js';
import type { CliScopePartial } from '../types.js';
import {
  CONFIG_FILE_MODE,
  ensureConfigDir,
  tightenConfigFile,
} from './permissions.js';
import { CliError } from '../types.js';

export const REDACTED_API_KEY = '***';

/**
 * Load and zod-validate the on-disk config. Returns a freshly-bootstrapped
 * empty config when the file does not exist (the caller decides whether
 * to bootstrap a `default` profile via `init`).
 */
export function loadConfig(file: string): CliConfigShape {
  if (!existsSync(file)) return emptyConfig();
  const raw = parseJson(file);
  const result = CliConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new CliError('usage', `invalid config at ${file}: ${issues}`);
  }
  return result.data;
}

function parseJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError('usage', `cannot parse config at ${file}: ${reason}`);
  }
}

/** Persist the config with strict directory + file permissions. */
export function saveConfig(
  file: string,
  dir: string,
  config: CliConfigShape,
): void {
  // Re-validate before writing — the runtime path may have constructed
  // an invalid object, and saving an invalid config would poison subsequent
  // loads.
  const validated = CliConfigSchema.parse(config);
  ensureConfigDir(dir);
  writeFileSync(file, JSON.stringify(validated, null, 2) + '\n', {
    mode: CONFIG_FILE_MODE,
  });
  tightenConfigFile(file);
}

export function getActiveProfile(config: CliConfigShape): CliProfileShape | null {
  return config.profiles[config.activeProfile] ?? null;
}

export function listProfileNames(config: CliConfigShape): string[] {
  return Object.keys(config.profiles).sort();
}

export function showProfile(
  config: CliConfigShape,
  name: string,
): CliProfileShape {
  const p = config.profiles[name];
  if (!p) {
    throw new CliError('not_found', `profile not found: ${name}`);
  }
  return redactProfile(p);
}

export function setActiveProfile(
  config: CliConfigShape,
  name: string,
): CliConfigShape {
  if (!config.profiles[name]) {
    throw new CliError('not_found', `profile not found: ${name}`);
  }
  return { ...config, activeProfile: name };
}

interface AddProfileOptions {
  /** Overwrite even if a profile of this name already has populated fields. */
  force?: boolean;
}

export function addProfile(
  config: CliConfigShape,
  name: string,
  profile: CliProfileShape,
  options: AddProfileOptions = {},
): CliConfigShape {
  const existing = config.profiles[name];
  if (existing && hasPopulatedFields(existing) && options.force !== true) {
    throw new CliError(
      'usage',
      `profile "${name}" already has populated fields; pass --force to overwrite`,
    );
  }
  return {
    ...config,
    profiles: { ...config.profiles, [name]: profile },
  };
}

/**
 * A profile is "populated" if ANY of its fields are set, including the
 * core provider/apiUrl/trustSurface/output and the apiKey/scope.* fields.
 * Without `--force`, calling `addProfile` against any populated profile
 * is rejected so an existing configuration cannot be silently clobbered
 * by a fresh `init` invocation.
 *
 * Per v5 §"Profiles": "init --force overwrites populated fields; without
 * --force, non-interactive init must fail before overwriting populated
 * fields, and interactive init must ask before replacing them."
 */
function hasPopulatedFields(profile: CliProfileShape): boolean {
  if (profile.apiKey) return true;
  if (profile.output) return true;
  // provider/apiUrl/trustSurface are required by the schema, so a stored
  // profile always has them; their mere presence indicates a previously
  // initialized profile that must not be silently overwritten.
  if (profile.provider) return true;
  if (profile.apiUrl) return true;
  if (profile.trustSurface) return true;
  const scope = profile.scope;
  if (scope) {
    if (scope.user || scope.agent_id || scope.namespace || scope.thread) {
      return true;
    }
  }
  return false;
}

/** Redact the apiKey field for any output that shows a profile to the user. */
export function redactProfile(profile: CliProfileShape): CliProfileShape {
  if (!profile.apiKey) return profile;
  return { ...profile, apiKey: REDACTED_API_KEY };
}

interface NonInitOverlay {
  /**
   * --provider <name> ephemeral override. v5 requires provider config
   * precedence flags > env > config; without `provider` here the global
   * --provider flag would be silently dropped on non-init invocations.
   */
  provider?: CliProfileShape['provider'];
  apiUrl?: string;
  output?: CliProfileShape['output'];
  scope?: CliScopePartial;
}

/**
 * Apply ephemeral non-init overlay to a profile. The result is a
 * transient view used for the current command only — callers must not
 * pass it back to `saveConfig`. Per v5 §"Profiles": "non-init flags are
 * ephemeral overlays and must not write config".
 *
 * trustSurface is intentionally NOT a NonInitOverlay field: v5 has no
 * global flag or env var for it, and silently switching trust surface
 * per-invocation would weaken the doctor-enforced trust contract.
 */
export function mergeNonInitOverlay(
  profile: CliProfileShape,
  overlay: NonInitOverlay,
): CliProfileShape {
  const merged: CliProfileShape = { ...profile };
  if (overlay.provider) merged.provider = overlay.provider;
  if (overlay.apiUrl) merged.apiUrl = overlay.apiUrl;
  if (overlay.output) merged.output = overlay.output;
  if (overlay.scope && Object.keys(overlay.scope).length > 0) {
    merged.scope = { ...(profile.scope ?? {}), ...overlay.scope };
  }
  return merged;
}
