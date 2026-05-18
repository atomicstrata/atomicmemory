/**
 * @file Top-level error rendering. Used by bin.ts before a full
 * runtime context exists (e.g. argv pre-parse failures, commander
 * usage errors). Emits the v5 envelope shape via the standard
 * renderers so the error path stays inside the Phase 1 renderer
 * boundary.
 *
 * For parse-time failures we sniff `--json` / `--agent` directly from
 * raw argv so agents that pre-flight `--json version` still receive a
 * JSON-shaped error envelope when commander throws.
 */

import { exitCodeFor } from '../output/envelope.js';
import { renderError } from '../renderers/index.js';
import type { ExitCode, OutputMode, RenderContext } from '../types.js';

export function renderTopLevelError(
  err: unknown,
  command: string,
  startTime: number,
  argv?: readonly string[],
): ExitCode {
  const error = err instanceof Error ? err : new Error(String(err));
  const ctx: RenderContext = {
    mode: detectArgvMode(argv ?? []),
    interactive: false,
    profileName: 'default',
    startTime,
    command,
    color: false,
  };
  renderError(ctx, error);
  return exitCodeFor(error);
}

function detectArgvMode(argv: readonly string[]): OutputMode {
  // Mirror resolveOutputMode's precedence at parse-error time:
  //   --agent (or --output=agent / --output agent) > --json > --output <mode> > text
  // Both split (`--output json`) and joined (`--output=json`) forms
  // must be recognized so machine callers get the right error
  // envelope even before commander sees the argv.
  let mode: OutputMode | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') return 'agent';
    const outputValue = readOutputValue(a, argv[i + 1]);
    if (outputValue === 'agent') return 'agent';
    if (a === '--json' && mode !== 'json') {
      mode = 'json';
      continue;
    }
    if (outputValue && mode === null) {
      mode = outputValue;
    }
  }
  return mode ?? 'text';
}

const VALID_OUTPUT_VALUES: ReadonlySet<OutputMode> = new Set([
  'text',
  'table',
  'json',
  'agent',
  'quiet',
]);

function readOutputValue(
  current: string | undefined,
  next: string | undefined,
): OutputMode | null {
  if (current === undefined) return null;
  if (current === '--output' && typeof next === 'string') {
    return VALID_OUTPUT_VALUES.has(next as OutputMode)
      ? (next as OutputMode)
      : null;
  }
  if (current.startsWith('--output=')) {
    const value = current.slice('--output='.length);
    return VALID_OUTPUT_VALUES.has(value as OutputMode)
      ? (value as OutputMode)
      : null;
  }
  return null;
}
