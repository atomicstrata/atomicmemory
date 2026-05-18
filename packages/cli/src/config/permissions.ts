/**
 * @file Filesystem permission enforcement for the CLI config dir/file.
 * Per v5 §"Must-Have Requirements": dir 0700, file 0600. Both `init`
 * and `doctor --fix` route through these helpers; nothing else is
 * permitted to create the config file (otherwise the permissions
 * guarantee is unchecked).
 */

import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';

export const CONFIG_DIR_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

/**
 * Create the config directory (recursive) if missing, then tighten to
 * 0700. We always chmod after mkdir because the process umask can
 * weaken `{ mode: 0o700 }` (effective mode is `mode & ~umask`); without
 * the explicit chmod, a default umask of 0o022 would leave the
 * directory at 0700 here but a stricter 0o077 user umask would leave
 * it at 0700, and a permissive 0o000 umask would still leave it at
 * 0700 — but in environments where mkdir's mode is silently downgraded
 * to a system default (some sandboxes), only the chmod guarantees the
 * 0700 invariant.
 */
export function ensureConfigDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: CONFIG_DIR_MODE, recursive: true });
    chmodSync(dir, CONFIG_DIR_MODE);
    return;
  }
  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`config dir path exists but is not a directory: ${dir}`);
  }
  chmodSync(dir, CONFIG_DIR_MODE);
}

/** Tighten the config file's permissions to 0600. Caller created the file. */
export function tightenConfigFile(path: string): void {
  if (!existsSync(path)) return;
  chmodSync(path, CONFIG_FILE_MODE);
}

/**
 * Inspect current permissions for diagnostics (used by `doctor` /
 * `validate` and tests). Returns the raw mode bits or null if the path
 * does not exist.
 */
export function readMode(path: string): number | null {
  if (!existsSync(path)) return null;
  return statSync(path).mode & 0o777;
}
