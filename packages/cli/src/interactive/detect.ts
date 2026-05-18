/**
 * @file Centralized interactivity detection. Per v5 §"Output Semantics"
 * the rule is exactly:
 *
 *   stdin.isTTY && stdout.isTTY && !CI && output === 'text'
 *
 * Plus an opt-out via `--no-interactive` and an explicit hint via
 * `--interactive` (which is rejected when output resolves to non-text;
 * that rejection lives in the lifecycle, not here).
 *
 * Everything that needs to know "should I run an Ink UI / show a prompt /
 * draw a spinner?" must call `isInteractive(opts)`. Do not re-derive this
 * rule elsewhere.
 */

import type { OutputMode } from '../types.js';

interface InteractivityInputs {
  mode: OutputMode;
  /** Set by the parsed --interactive / --no-interactive global flag. */
  hint: boolean | null;
  /** Process streams + env. Injected for testability. */
  env?: NodeJS.ProcessEnv;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
}

export function isInteractive(opts: InteractivityInputs): boolean {
  if (opts.hint === false) return false;
  if (opts.mode !== 'text') return false;

  const env = opts.env ?? process.env;
  if (env.CI === 'true' || env.CI === '1') return false;

  const stdinTTY = opts.stdinTTY ?? Boolean(process.stdin.isTTY);
  const stdoutTTY = opts.stdoutTTY ?? Boolean(process.stdout.isTTY);
  if (!stdinTTY || !stdoutTTY) return false;

  // hint === true reaches here only after every other check passed; either way
  // the inputs already justify launching, so the hint is simply consistent.
  return true;
}
