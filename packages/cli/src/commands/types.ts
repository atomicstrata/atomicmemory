/**
 * @file Shared command types: every Phase 5 command handler returns a
 * CommandResult and consumes a CommandContext. The lifecycle in bin.ts
 * builds the context once and dispatches on the matched spec command.
 *
 * Handlers MUST NOT import the SDK or write to stdout/stderr — those
 * boundaries are enforced by the AST regression scans. Provider access
 * goes through `ctx.getAdapter()` which lazily constructs the adapter
 * via the Phase 4 registry.
 */

import type { ProviderAdapter } from '../adapters/types.js';
import type {
  CliConfigShape,
  CliProfileShape,
} from '../config/schema.js';
import type {
  CliScopePartial,
  CommandResult,
  ProviderCapabilities,
} from '../types.js';

export interface CommandFlags {
  [name: string]: unknown;
}

export interface AdapterHandle {
  adapter: ProviderAdapter;
  capabilities: ProviderCapabilities;
}

export interface CommandContext {
  /** The spec command name (top-level) and any subcommand path joined with " ". */
  command: string;
  /** Positional arguments for this command (excluding the command name). */
  positional: string[];
  /** Parsed + validated commander options/flags for this command + globals. */
  flags: CommandFlags;
  /** Persisted config (loaded from disk; may be empty if no config exists yet). */
  config: CliConfigShape;
  configPath: string;
  configDir: string;
  /**
   * Active profile after applying any non-init ephemeral overlay
   * (flags > env > config) for this invocation. Profile.apiKey reflects
   * the resolved key (env > stdin > profile.apiKey).
   *
   * `null` means no profile was configured AND no equivalent
   * flag/env combo (--provider + --api-url) supplied one. Commands
   * that touch the provider must check for null or call
   * `ctx.getAdapter()` (which throws CliError('usage') in that case).
   * Commands that work without a provider — init, help, version,
   * skill, completion, config show/get/set/unset, validate (offline)
   * — proceed normally.
   */
  profile: CliProfileShape | null;
  /**
   * Resolved scope after flags > env > profile.scope. May lack `user`
   * for commands that do not require it; commands that require a user
   * call `requireScope()` (helper in commands/scope.ts) which throws
   * missing_user (exit 2) when absent.
   */
  scope: CliScopePartial;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Reads stdin to a string. Returns '' on a TTY. Caller awaits explicitly. */
  readStdin: () => Promise<string>;
  /** True when --experimental was passed; gates hidden commands. */
  experimental: boolean;
  /**
   * Lazily construct the active provider adapter, initialize it, and
   * cache its capabilities. Subsequent calls reuse the cached handle.
   * Implementation lives in the lifecycle wiring (bin.ts).
   */
  getAdapter: () => Promise<AdapterHandle>;
}

export type CommandHandler<T = unknown> = (
  ctx: CommandContext,
) => Promise<CommandResult<T>>;

interface CommandRegistration {
  /** Joined path: "init", "config show", "config profile use", etc. */
  name: string;
  handler: CommandHandler;
}
