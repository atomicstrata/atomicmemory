/**
 * @file Foundational CLI types — shared across commands, adapters, renderers,
 * config, and lifecycle. SDK types are intentionally NOT re-exported here;
 * adapters translate SDK shapes into the CLI shapes below.
 *
 * Phase 1 establishes the contracts. Phase 4 (adapters) and Phase 5 (commands)
 * extend the result/envelope shapes with command-specific data types.
 */

export type OutputMode = 'text' | 'json' | 'agent' | 'table' | 'quiet';

export type ExitCode = 0 | 1 | 2 | 3 | 4;

/**
 * v5 exit-code matrix:
 *   0 success
 *   1 runtime/provider error
 *   2 usage, validation, missing input, capability gate, experimental gate
 *   3 connectivity / auth / configuration failure
 *   4 not found
 */

export interface CliScope {
  user: string;
  /**
   * v5 canonical CLI scope field. Surfaced via the `--agent-id` global flag.
   * Phase 4 adapters map this onto SDK `Scope.agent` when calling the SDK.
   */
  agent_id?: string;
  namespace?: string;
  thread?: string;
}

/**
 * Partial of CliScope used by RenderContext, CliOutputEnvelope, and
 * resolveScope. Each field is `string | undefined` (rather than the
 * strict-optional `?: string`) so values that came through zod
 * `.optional()` — e.g. CliScopePartial in config/schema.ts — assign
 * cleanly into a RenderContext under exactOptionalPropertyTypes.
 */
export type CliScopePartial = {
  user?: string | undefined;
  agent_id?: string | undefined;
  namespace?: string | undefined;
  thread?: string | undefined;
};

export type TrustSurface = 'local' | 'self-hosted' | 'authenticated-wrapper';

export interface CliProfile {
  provider: 'atomicmemory' | 'mem0';
  apiUrl: string;
  trustSurface: TrustSurface;
  scope?: CliScopePartial;
  output?: OutputMode;
  /**
   * apiKey is optional. It is persisted only via:
   *   - interactive `init` (TTY) after the user confirms the consent prompt
   *   - non-interactive `init --api-key-stdin --save-api-key`
   * Non-init commands never write apiKey. Plain --api-key <value> is rejected.
   */
  apiKey?: string;
}

export interface CliConfig {
  schema_version: '2';
  activeProfile: string;
  profiles: Record<string, CliProfile>;
}

export interface ProviderCapabilities {
  ingestModes: Array<'text' | 'messages' | 'verbatim'>;
  requiredScope?: Record<string, Array<keyof CliScope>>;
  extensions: { package: boolean; [key: string]: unknown };
  maxTokenBudget?: number;
  supportedRerankers?: string[];
  supportedFilterOps?: string[];
  /**
   * Custom (provider-specific) extensions. AtomicMemory exposes
   * atomicmemory.lifecycle, .audit, .lessons, .config, .agents.
   * Used by experimental command capability gates.
   */
  customExtensions?: Record<string, unknown>;
}

export type CliErrorCode =
  | 'missing_user'
  | 'missing_scope_field'
  | 'missing_input'
  | 'unsupported_capability'
  | 'experimental_disabled'
  | 'usage'
  | 'connectivity'
  | 'auth'
  | 'not_found'
  | 'runtime';

/**
 * Maps each CliErrorCode to its v5 default exit code per the matrix at the
 * top of this file:
 *   runtime                     -> 1
 *   connectivity, auth          -> 3
 *   not_found                   -> 4
 *   usage, missing_input,
 *   missing_user,
 *   missing_scope_field,
 *   unsupported_capability,
 *   experimental_disabled       -> 2
 *
 * Callers should rely on this default; passing an explicit override to the
 * CliError constructor is supported but discouraged unless the contextual
 * meaning of the error genuinely diverges from the code's category.
 */
export function defaultExitCodeFor(code: CliErrorCode): ExitCode {
  switch (code) {
    case 'runtime':
      return 1;
    case 'connectivity':
    case 'auth':
      return 3;
    case 'not_found':
      return 4;
    case 'usage':
    case 'missing_input':
    case 'missing_user':
    case 'missing_scope_field':
    case 'unsupported_capability':
    case 'experimental_disabled':
      return 2;
  }
}

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: ExitCode;

  constructor(code: CliErrorCode, message: string, exitCode?: ExitCode) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode ?? defaultExitCodeFor(code);
  }
}

export interface ProgressEvent {
  type: 'info' | 'progress' | 'warn';
  message: string;
  meta?: Record<string, unknown>;
}

/**
 * Typed value returned by every command handler. Renderers translate this
 * into stdout per the active OutputMode. Command handlers MUST NOT write to
 * stdout/stderr directly; that boundary is enforced by an AST regression
 * test (renderer-purity-test).
 */
export interface CommandResult<T = unknown> {
  command: string;
  data: T;
  count?: number;
  meta?: Record<string, unknown>;
  events?: ProgressEvent[];
}

/**
 * The wire envelope used by --agent (and structurally by --json with sanitized
 * data). Matches the v5 plan §"Agent Envelope Examples" exactly.
 */
export interface CliOutputEnvelope<T = unknown> {
  status: 'success' | 'error';
  command: string;
  duration_ms: number;
  profile: string;
  scope?: CliScopePartial;
  count: number;
  data: T | null;
  meta?: Record<string, unknown>;
  error?: { code: CliErrorCode | string; message: string };
}

export interface RenderContext {
  mode: OutputMode;
  interactive: boolean;
  profileName: string;
  scope?: CliScopePartial;
  startTime: number;
  command: string;
  /** When true, ANSI color sequences may be emitted. Always false for json/agent/quiet. */
  color: boolean;
}
