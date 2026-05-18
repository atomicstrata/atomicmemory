/**
 * @file `atomicmemory doctor` — health diagnostics. Runs the v5 check
 * matrix from `./checks.ts`, honoring `--quick` (skip slow + network),
 * `--offline` (skip network), and `--fix` (apply safe local repairs;
 * mkdir + chmod only).
 *
 * Stable check IDs and categories make the JSON output testable
 * across releases. Per v5: `--fix` never writes credentials, never
 * mutates provider data, never selects another profile.
 */

import type { CommandContext, CommandHandler } from '../../types.js';
import { CHECKS } from './checks.js';
import type {
  DoctorCheckResult,
  DoctorCheckSpec,
  DoctorMode,
} from './types.js';

export const doctor: CommandHandler<{
  ok: boolean;
  mode: DoctorMode;
  fix: boolean;
  fixedAny: boolean;
  checks: DoctorCheckResult[];
}> = async (ctx) => {
  const fix = ctx.flags.fix === true;
  const mode = resolveDoctorMode(ctx);

  const eligible = CHECKS.filter((c) => isCheckEligible(c, mode));
  const outcomes = await runChecks(eligible, ctx, fix);

  const ok = outcomes.results.every((c) => c.ok);
  return {
    command: 'doctor',
    data: { ok, mode, fix, fixedAny: outcomes.fixedAny, checks: outcomes.results },
    count: outcomes.results.length,
    meta: { mode, fix, fixedAny: outcomes.fixedAny },
  };
};

function resolveDoctorMode(ctx: CommandContext): DoctorMode {
  if (ctx.flags.offline === true) return 'offline';
  if (ctx.flags.quick === true) return 'quick';
  return 'full';
}

function isCheckEligible(check: DoctorCheckSpec, mode: DoctorMode): boolean {
  if (mode === 'offline' && check.network) return false;
  if (mode === 'quick' && (check.network || check.slow)) return false;
  return true;
}

interface DoctorRunOutcome {
  results: DoctorCheckResult[];
  fixedAny: boolean;
}

async function runChecks(
  checks: readonly DoctorCheckSpec[],
  ctx: CommandContext,
  fix: boolean,
): Promise<DoctorRunOutcome> {
  const results: DoctorCheckResult[] = [];
  let fixedAny = false;
  for (const check of checks) {
    const result = await runOneCheck(check, ctx, fix);
    if (result.fixed === true) fixedAny = true;
    results.push(result);
  }
  return { results, fixedAny };
}

async function runOneCheck(
  check: DoctorCheckSpec,
  ctx: CommandContext,
  fix: boolean,
): Promise<DoctorCheckResult> {
  const initial = await check.run(ctx);
  if (initial.ok || !fix || !initial.fixable || !check.fix) return initial;
  return check.fix(ctx);
}
