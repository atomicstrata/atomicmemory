/**
 * @file Config file/directory location resolution. Default location is
 * `~/.atomicmemory/config.json`; overrides come from
 *   1. `--config <path>` (parsed as flag and passed in by the lifecycle)
 *   2. `ATOMICMEMORY_CONFIG` env var
 *
 * No filesystem actions happen here — this module only computes paths.
 * Permission enforcement lives in `permissions.ts`.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface ConfigPaths {
  /** Directory that holds the config file (must be 0700). */
  dir: string;
  /** Absolute path to the config JSON file (must be 0600). */
  file: string;
}

interface ConfigPathInputs {
  /** `--config <path>` value (highest precedence). */
  flagOverride?: string;
  /** `ATOMICMEMORY_CONFIG` env var (second precedence). */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_DIR_NAME = '.atomicmemory';
const DEFAULT_FILE_NAME = 'config.json';

export function resolveConfigPaths(inputs: ConfigPathInputs = {}): ConfigPaths {
  const env = inputs.env ?? process.env;
  const explicit =
    nonEmpty(inputs.flagOverride) ?? nonEmpty(env.ATOMICMEMORY_CONFIG);
  if (explicit) {
    return { dir: dirname(explicit), file: explicit };
  }
  const dir = join(homedir(), DEFAULT_DIR_NAME);
  return { dir, file: join(dir, DEFAULT_FILE_NAME) };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
