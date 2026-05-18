/**
 * @file JSON renderer — emits the raw, full-fidelity result as JSON to
 * stdout. Distinct from agent mode (which sanitizes). Errors go to stderr
 * as JSON. Never emits ANSI sequences.
 */

import { buildErrorEnvelope } from '../output/envelope.js';
import type { CommandResult, RenderContext } from '../types.js';

export function renderJsonSuccess<T>(
  ctx: RenderContext,
  result: CommandResult<T>,
): void {
  const payload = {
    command: result.command,
    duration_ms: Date.now() - ctx.startTime,
    profile: ctx.profileName,
    scope: ctx.scope,
    count: result.count ?? (Array.isArray(result.data) ? result.data.length : 1),
    data: result.data,
    meta: result.meta,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

export function renderJsonError(ctx: RenderContext, err: Error): void {
  const envelope = buildErrorEnvelope(ctx, err);
  process.stderr.write(JSON.stringify(envelope) + '\n');
}
