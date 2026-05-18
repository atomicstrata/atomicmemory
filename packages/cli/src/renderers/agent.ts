/**
 * @file Agent renderer — emits the v5 stable envelope with sanitized data.
 * Both success and error envelopes go to stdout (agent mode rule: errors are
 * machine-parseable on stdout, exit code conveys success/failure). Never
 * emits ANSI sequences. The sanitizer for the active command must be
 * registered in the envelope registry; otherwise rendering raises.
 */

import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  sanitizeForAgent,
} from '../output/envelope.js';
import type { CommandResult, RenderContext } from '../types.js';

export function renderAgentSuccess<T>(
  ctx: RenderContext,
  result: CommandResult<T>,
): void {
  const sanitized = sanitizeForAgent<T, T>(result.command, result.data, ctx);
  const envelope = buildSuccessEnvelope(ctx, result, sanitized);
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

export function renderAgentError(ctx: RenderContext, err: Error): void {
  const envelope = buildErrorEnvelope(ctx, err);
  // Agent error envelopes go to stdout per v5; stderr is reserved for human errors.
  process.stdout.write(JSON.stringify(envelope) + '\n');
}
