/**
 * @file Quiet renderer — emits nothing on success AND nothing on
 * error. The exit code is the only signal. Per v5: "quiet emits no
 * stdout on success; use json or agent when callers need IDs or
 * counts." The same silence applies to errors so `--output quiet`
 * stays scriptable. Never emits ANSI.
 */

import type { CommandResult, RenderContext } from '../types.js';

export function renderQuietSuccess<T>(
  _ctx: RenderContext,
  _result: CommandResult<T>,
): void {
  // intentional no-op
}

export function renderQuietError(_ctx: RenderContext, _err: Error): void {
  // intentional no-op; exit code conveys the failure.
}
