/**
 * @file Flag normalization. Commander 12 stores multi-word options
 * under camelCased keys (`tokenBudget`, `agentId`, `apiKeyStdin`),
 * but the cli-spec / our handlers / test fixtures all use hyphenated
 * names (`token-budget`, `agent-id`, `api-key-stdin`). Normalize at
 * the boundary so handlers see exactly one canonical shape.
 *
 * Numeric flags are validated and converted to numbers here too,
 * before the lifecycle dispatches to a handler. Invalid values surface
 * as CliError('usage', ...) (exit 2) per v5 §"Output Semantics".
 */

import { CliError } from '../types.js';
import type { CommandFlags } from '../commands/types.js';

/**
 * Spec-driven set of flag names whose declared placeholder is numeric
 * (i.e. parses as a Number). Drift between this set and the spec is
 * checked at startup by parser-drift.
 */
const NUMERIC_FLAGS: ReadonlySet<string> = new Set([
  'limit',
  'token-budget',
]);

export function normalizeCommanderFlags(
  raw: Record<string, unknown>,
): CommandFlags {
  const out: CommandFlags = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = camelToHyphen(key);
    out[canonical] = value;
  }
  validateNumericFlags(out);
  return out;
}

function camelToHyphen(key: string): string {
  return key.replace(/([A-Z])/g, (_, c: string) => `-${c.toLowerCase()}`);
}

function validateNumericFlags(flags: CommandFlags): void {
  for (const name of NUMERIC_FLAGS) {
    const raw = flags[name];
    if (raw === undefined) continue;
    if (typeof raw === 'number') continue; // already numeric
    if (typeof raw !== 'string') {
      throw new CliError(
        'usage',
        `--${name} must be a number; got ${typeof raw}`,
      );
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new CliError(
        'usage',
        `--${name} must be a finite number; got "${raw}"`,
      );
    }
    if (n < 0) {
      throw new CliError(
        'usage',
        `--${name} must be non-negative; got ${n}`,
      );
    }
    flags[name] = n;
  }
}

/** Test-only helper: expose the canonical-name map for assertions. */
function _numericFlagNames(): readonly string[] {
  return Array.from(NUMERIC_FLAGS).sort();
}
