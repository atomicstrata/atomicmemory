/**
 * @file Output-mode policy: validation, default selection, allow-list
 * enforcement, the --interactive guard, and the Ink launch decision.
 *
 * `defaultModeFor` reads cli-spec.json's `default_output` field when
 * present and falls back to `allowed_outputs[0]`. This is how `list`
 * defaults to `table` even though `text` is also allowed.
 */

import { CliError, type OutputMode } from '../types.js';
import { loadSpec } from '../spec/loader.js';
import { isInteractive } from '../interactive/detect.js';
import type { CommandFlags } from '../commands/types.js';

const VALID_OUTPUT_MODES = new Set<OutputMode>([
  'text',
  'table',
  'json',
  'agent',
  'quiet',
]);

export function rejectInvalidOutputFlag(flags: CommandFlags): void {
  const value = flags.output;
  if (typeof value !== 'string') return;
  if (!VALID_OUTPUT_MODES.has(value as OutputMode)) {
    throw new CliError(
      'usage',
      `invalid --output value "${value}"; expected text|table|json|agent|quiet`,
    );
  }
}

export function rejectStdinFlagCombo(flags: CommandFlags): void {
  if (flags['api-key-stdin'] === true && flags.stdin === true) {
    throw new CliError(
      'usage',
      '--api-key-stdin and --stdin both consume process stdin and cannot be combined',
    );
  }
}

export function rejectInteractiveOnNonText(
  flags: CommandFlags,
  mode: OutputMode,
): void {
  if (flags.interactive === true && mode !== 'text') {
    throw new CliError(
      'usage',
      `--interactive is only valid when output mode is "text"; got "${mode}"`,
    );
  }
}

/**
 * Resolve the default output mode for a command from cli-spec.json.
 * Prefers the explicit `default_output` field; falls back to the
 * first entry of `allowed_outputs`. Used by Phase 5 dispatch so
 * `list` defaults to `table` (per v5 plan §"Per-command defaults").
 */
export function defaultModeFor(commandPath: string): OutputMode {
  const spec = loadSpec();
  const top = commandPath.split(' ')[0]!;
  const cmd = spec.commands.find((c) => c.name === top);
  if (cmd?.default_output) return cmd.default_output;
  return cmd?.allowed_outputs[0] ?? 'text';
}

export function enforceAllowedOutputs(
  commandPath: string,
  mode: OutputMode,
): void {
  const spec = loadSpec();
  const top = commandPath.split(' ')[0]!;
  const cmd = spec.commands.find((c) => c.name === top);
  if (!cmd) return;
  if (!cmd.allowed_outputs.includes(mode)) {
    throw new CliError(
      'usage',
      `command "${top}" does not support output "${mode}"; allowed: ${cmd.allowed_outputs.join('|')}`,
    );
  }
}

/**
 * v5 Ink launch decision. The single source of truth is
 * `isInteractive` in `interactive/detect.ts`; this thin wrapper
 * adapts CommandFlags to the InteractivityInputs shape so the
 * runtime can ask "should Ink mount?" without duplicating the rule.
 *
 * Ink ships as the human TTY renderer inside text mode. Disabled for
 * machine modes, non-TTY streams, CI, and when `--no-interactive`
 * is passed. `--interactive` is treated as an opt-in hint — it does
 * NOT override the other suppressors.
 */
export function inkShouldLaunch(
  flags: CommandFlags,
  mode: OutputMode,
  env: NodeJS.ProcessEnv,
): boolean {
  const hint =
    flags.interactive === true
      ? true
      : flags.interactive === false
        ? false
        : null;
  return isInteractive({ mode, hint, env });
}
