/**
 * @file Plain text renderer — human-readable output to stdout. Used when
 * mode === 'text' AND interactivity detection chose plain text over Ink.
 * May emit ANSI color when ctx.color is true; never emits in JSON modes.
 *
 * Phase 1 ships a minimal renderer that prints the result's `data` plus any
 * trailing progress events. Phase 5 commands can supply richer per-command
 * text formatters by extending this renderer; for now, a generic shape
 * keeps the contract honest.
 */

import type { CommandResult, ProgressEvent, RenderContext } from '../types.js';

export function renderTextSuccess<T>(
  ctx: RenderContext,
  result: CommandResult<T>,
): void {
  for (const event of result.events ?? []) {
    process.stdout.write(formatProgressLine(event, ctx.color) + '\n');
  }
  // Hook commands set `meta.host_text_format = 'compact-json'` when
  // the host (Claude Code / Codex) reads stdout as a single compact
  // JSON line. Honor the hint so structured `data` survives both wire
  // formats unchanged: `--json`/`--agent` wrap the structured object
  // in their envelopes, and text mode emits the equivalent compact
  // JSON for the host. Empty data still suppresses the line.
  if (isCompactJsonRequested(result.meta) && result.data != null) {
    const compact = JSON.stringify(result.data);
    if (compact.length > 0 && compact !== '""' && compact !== 'null') {
      process.stdout.write(compact + '\n');
    }
    return;
  }
  // Empty data → no trailing line. Hook commands return `data: ''`
  // for both skips (`prompt_too_short`, `no_content`, `no_hits`,
  // `low_signal`) and lifecycle-write success cases; in default text
  // mode they must produce zero stdout so generated host snippets
  // never inject an empty turn into Claude Code / Codex transcripts.
  // Machine modes (json/agent) wrap their own envelopes and surface
  // `meta.skipped` / `meta.reason` independently of this branch.
  const formatted = formatData(result.data, ctx.color);
  if (formatted.length > 0) process.stdout.write(formatted + '\n');
}

function isCompactJsonRequested(meta: CommandResult<unknown>['meta']): boolean {
  if (!meta || typeof meta !== 'object') return false;
  return (meta as Record<string, unknown>).host_text_format === 'compact-json';
}

export function renderTextError(ctx: RenderContext, err: Error): void {
  const tag = ctx.color ? '[31merror:[0m' : 'error:';
  process.stderr.write(`${tag} ${err.message}\n`);
}

function formatProgressLine(event: ProgressEvent, color: boolean): string {
  const tags: Record<ProgressEvent['type'], string> = color
    ? {
        info: '[36m[info][0m',
        progress: '[36m[progress][0m',
        warn: '[33m[warn][0m',
      }
    : { info: '[info]', progress: '[progress]', warn: '[warn]' };
  return `${tags[event.type]} ${event.message}`;
}

function formatData(data: unknown, _color: boolean): string {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  return JSON.stringify(data, null, 2);
}
