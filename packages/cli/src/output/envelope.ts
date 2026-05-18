/**
 * @file Agent/JSON envelope builders, the per-command sanitizer registry, and
 * exit-code mapping. Renderers consume the envelope; commands provide the
 * unsanitized typed result and (when registered) a sanitizer that strips
 * provider internals before agent loops see it.
 */

import {
  CliError,
  type CliOutputEnvelope,
  type CommandResult,
  type ExitCode,
  type RenderContext,
} from '../types.js';

export function buildSuccessEnvelope<T>(
  ctx: RenderContext,
  result: CommandResult<T>,
  agentData: T | null,
): CliOutputEnvelope<T> {
  const count = resolveCount(result.count, agentData);
  const envelope: CliOutputEnvelope<T> = {
    status: 'success',
    command: result.command,
    duration_ms: Date.now() - ctx.startTime,
    profile: ctx.profileName,
    count,
    data: agentData,
  };
  if (ctx.scope) envelope.scope = ctx.scope;
  if (result.meta) envelope.meta = result.meta;
  return envelope;
}

export function buildErrorEnvelope(
  ctx: RenderContext,
  err: Error,
): CliOutputEnvelope<null> {
  const code = err instanceof CliError ? err.code : 'runtime';
  const envelope: CliOutputEnvelope<null> = {
    status: 'error',
    command: ctx.command,
    duration_ms: Date.now() - ctx.startTime,
    profile: ctx.profileName,
    count: 0,
    data: null,
    error: { code, message: err.message },
  };
  if (ctx.scope) envelope.scope = ctx.scope;
  return envelope;
}

export function exitCodeFor(err: Error): ExitCode {
  if (err instanceof CliError) return err.exitCode;
  return 1;
}

function resolveCount(explicit: number | undefined, data: unknown): number {
  if (typeof explicit === 'number') return explicit;
  if (Array.isArray(data)) return data.length;
  if (data == null) return 0;
  return 1;
}

/**
 * Per-command sanitizer registry. Phase 4/5 commands register a sanitizer that
 * strips provider internals (raw vectors, transport debug fields, secrets)
 * from the typed result before it reaches the agent envelope. Until a
 * sanitizer is registered for a command, agent mode for that command will
 * raise — that is intentional: the agent contract must be opt-in and
 * source-truthful, not a default passthrough that leaks SDK shape.
 */
type Sanitizer<TIn = unknown, TOut = unknown> = (
  input: TIn,
  ctx: RenderContext,
) => TOut;

const sanitizers = new Map<string, Sanitizer>();

export function registerSanitizer<TIn, TOut>(
  command: string,
  fn: Sanitizer<TIn, TOut>,
): void {
  sanitizers.set(command, fn as Sanitizer);
}

export function hasSanitizer(command: string): boolean {
  return sanitizers.has(command);
}

export function sanitizeForAgent<TIn, TOut>(
  command: string,
  input: TIn,
  ctx: RenderContext,
): TOut {
  const fn = sanitizers.get(command);
  if (!fn) {
    throw new CliError(
      'runtime',
      `no agent sanitizer registered for command "${command}". Agent mode requires an explicit sanitizer.`,
      1,
    );
  }
  return fn(input, ctx) as TOut;
}

/** Test-only: clear the registry between unit tests. */
export function _resetSanitizers(): void {
  sanitizers.clear();
}
