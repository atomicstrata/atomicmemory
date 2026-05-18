/**
 * @file API-key handling rules. Per v5 §"Config + named profiles":
 *
 *   - Plain `--api-key <value>` is rejected at parse time (exit 2 usage)
 *     so secrets do not land in shell history.
 *   - `--api-key-stdin` reads the key from stdin and is permitted on
 *     every provider-touching command.
 *   - `init --api-key-stdin --save-api-key` persists the key into the
 *     named profile. Without `--save-api-key` the stdin key is consumed
 *     for one-shot validation and discarded.
 *   - Interactive `init` (TTY) may persist after an explicit consent
 *     prompt; the prompt itself lives in the renderer impl, not here.
 *   - Runtime resolution priority:
 *       ATOMICMEMORY_API_KEY env var
 *     > ephemeral --api-key-stdin overlay for the current command
 *     > profile.apiKey from disk
 *
 * Non-init commands never write `apiKey` to disk; that rule is enforced
 * by where `saveConfig` is called from, not by this module.
 */

import { CliError } from '../types.js';

export const API_KEY_ENV_VAR = 'ATOMICMEMORY_API_KEY';

/**
 * Reject any literal `--api-key` flag in the argv. Should be called by
 * the parser entrypoint BEFORE commander runs so the rejection is
 * deterministic regardless of which command was invoked.
 */
export function rejectPlainApiKeyFlag(rawArgs: readonly string[]): void {
  for (const arg of rawArgs) {
    if (arg === '--api-key' || arg.startsWith('--api-key=')) {
      throw new CliError(
        'usage',
        '--api-key <value> is rejected to keep secrets out of shell history; use --api-key-stdin or set ATOMICMEMORY_API_KEY',
      );
    }
  }
}

interface ResolveApiKeyInputs {
  /** ATOMICMEMORY_API_KEY value if present (after trim). */
  envApiKey?: string;
  /** Value just read from stdin via --api-key-stdin (after trim). */
  stdinApiKey?: string;
  /** Persisted profile.apiKey from disk. */
  profileApiKey?: string;
}

/**
 * Compute the API key to use for the current invocation.
 * env > stdin > profile (per v5 §"Config + named profiles"). Returns
 * undefined when no key is available; caller decides whether the
 * operation requires one.
 */
export function resolveApiKey(inputs: ResolveApiKeyInputs): string | undefined {
  return (
    cleanKey(inputs.envApiKey) ??
    cleanKey(inputs.stdinApiKey) ??
    cleanKey(inputs.profileApiKey)
  );
}

interface ShouldPersistInitKeyInputs {
  /** Was the key supplied via --api-key-stdin? */
  hasStdinKey: boolean;
  /** Was --save-api-key passed? Only valid on `init`. */
  saveApiKey: boolean;
  /** Did interactive `init` prompt the user and receive consent? */
  interactiveConsent?: boolean;
}

/**
 * Decide whether `init` should write the supplied key into the named
 * profile on disk.
 *   - Interactive TTY init: persist iff consent prompt accepted.
 *   - Non-interactive init: persist iff both --api-key-stdin AND
 *     --save-api-key were passed.
 *   - Otherwise: never persist (key consumed for one-shot validation
 *     and discarded).
 */
export function shouldPersistInitKey(
  inputs: ShouldPersistInitKeyInputs,
): boolean {
  if (inputs.interactiveConsent === true) return true;
  if (inputs.hasStdinKey && inputs.saveApiKey) return true;
  return false;
}

function cleanKey(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
