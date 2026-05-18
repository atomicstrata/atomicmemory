/**
 * @file Shared hook command types and parsing helpers for
 * `atomicmemory hooks install|run`.
 */

import { CliError } from '../../../types.js';
import { assertLimit } from '../../../cli/limits.js';

type HookAction = 'install' | 'run';
export type HookHost = 'codex' | 'claude-code';
export type HookRuntime = 'node' | 'python';
export type HookEvent = 'user-prompt-submit' | 'post-compact' | 'stop';
export type HookSkipReason =
  | 'no_content'
  | 'prompt_too_short'
  | 'no_hits'
  | 'low_signal';

/**
 * Char-limit defaults for hook content. Match the shell hook helpers in
 * `plugins/claude-code/scripts/lib/atomicmemory.sh`. Each is overridable
 * per host via the named env var so operators with shorter or longer
 * payloads (for example Codex stop responses) can dial the threshold
 * without code changes. No silent fallbacks: if the env var is set but
 * invalid, we surface a usage error.
 */
export const COMPACT_MAX_SUMMARY_CHARS = 2400;
export const STOP_MAX_SUMMARY_CHARS = 600;
export const STOP_MIN_ASSISTANT_CHARS = 200;

export const COMPACT_MAX_SUMMARY_ENV = 'ATOMICMEMORY_COMPACT_MAX_SUMMARY_CHARS';
export const STOP_MAX_SUMMARY_ENV = 'ATOMICMEMORY_STOP_MAX_SUMMARY_CHARS';
export const STOP_MIN_ASSISTANT_ENV = 'ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS';

/**
 * Per-hit and total char caps for the prompt-context injection path
 * (`hooks run user-prompt-submit`). Keeps a single retrieved memory
 * from blowing up the next agent turn AND keeps the combined context
 * bounded so a poisoned hit list cannot drive the host out of budget.
 */
export const PROMPT_CONTEXT_PER_HIT_CHARS = 800;
export const PROMPT_CONTEXT_TOTAL_CHARS = 4000;

export const PROMPT_CONTEXT_PER_HIT_ENV = 'ATOMICMEMORY_PROMPT_CONTEXT_PER_HIT_CHARS';
export const PROMPT_CONTEXT_TOTAL_ENV = 'ATOMICMEMORY_PROMPT_CONTEXT_TOTAL_CHARS';

export function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new CliError('usage', `${name} must be a positive integer; got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError('usage', `${name} must be a positive integer; got "${raw}"`);
  }
  return value;
}

export interface HookSnippet {
  target: string;
  language: 'toml' | 'json';
  content: string;
}

export interface HooksInstallPlan {
  action: 'install';
  host: HookHost;
  runtime: HookRuntime;
  defaultRuntime: HookRuntime;
  runtimeTier: 'recommended' | 'advanced';
  installMode: 'manual-config';
  commandTemplate: string;
  requiredEnv: string[];
  snippets: HookSnippet[];
  notes: string[];
}

/**
 * Wire shape consumed by the host (Claude Code / Codex) when the
 * UserPromptSubmit hook returns context. We carry it as structured
 * data so `--json` / `--agent` envelopes do not show a JSON-string-
 * inside-JSON-string. The text renderer emits the equivalent compact
 * JSON via `meta.host_text_format = 'compact-json'`.
 */
export interface UserPromptSubmitHookOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export type HookRunResult = '' | UserPromptSubmitHookOutput;

export type HooksResult = HooksInstallPlan | HookRunResult;

const DEFAULT_HOST: HookHost = 'codex';
export const DEFAULT_RUNTIME: HookRuntime = 'node';
const DEFAULT_PROMPT_SEARCH_LIMIT = 5;
export const MIN_PROMPT_CHARS = 20;

export const COMMON_REQUIRED_ENV = [
  'ATOMICMEMORY_API_URL or saved atomicmemory CLI profile',
  'ATOMICMEMORY_PROVIDER=atomicmemory or saved atomicmemory CLI profile',
  'ATOMICMEMORY_TRUST_SURFACE or saved atomicmemory CLI profile',
  'ATOMICMEMORY_SCOPE_USER or saved profile scope.user',
];

export function parseAction(value: unknown): HookAction {
  if (value === 'install' || value === 'run') return value;
  throw new CliError('usage', 'hooks requires action "install" or "run"');
}

export function parseHost(value: unknown): HookHost {
  if (value === undefined) return DEFAULT_HOST;
  if (value === 'codex' || value === 'claude-code') return value;
  throw new CliError('usage', `--host must be codex|claude-code; got "${String(value)}"`);
}

export function parseRuntime(value: unknown): HookRuntime {
  if (value === undefined) return DEFAULT_RUNTIME;
  if (value === 'node' || value === 'python') return value;
  throw new CliError('usage', `--runtime must be node|python; got "${String(value)}"`);
}

export function parseEvent(value: unknown): HookEvent {
  const normalized = typeof value === 'string'
    ? value
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replaceAll('_', '-')
        .toLowerCase()
    : '';
  if (
    normalized === 'user-prompt-submit' ||
    normalized === 'post-compact' ||
    normalized === 'stop'
  ) {
    return normalized;
  }
  throw new CliError(
    'usage',
    'hooks run requires event user-prompt-submit, post-compact, or stop',
  );
}

export function readLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PROMPT_SEARCH_LIMIT;
  if (typeof raw !== 'number') {
    throw new CliError('usage', '--limit must be a number');
  }
  assertLimit(raw);
  return raw;
}
