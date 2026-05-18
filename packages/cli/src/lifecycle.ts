/**
 * @file Command lifecycle — the single ordered pipeline every v5 command
 * goes through, in this exact order:
 *
 *   1. parse              (commander, populated by Phase 2)
 *   2. resolve            (config + zod-validate flags; Phase 3)
 *   3. static scope       (require user; fail with `missing_user` exit 2)
 *   4. adapter init       (Phase 4)
 *   5. capabilities       (load + cache once)
 *   6. dynamic scope      (Capabilities.requiredScope; fail with
 *                          `missing_scope_field` exit 2)
 *   7. interactive gate   (--interactive rejected when mode is non-text)
 *   8. execute            (command handler returns CommandResult)
 *   9. render              (renderer dispatch)
 *
 * Phase 1 ships the type contracts and the dispatch wiring; Phase 4/5 plug
 * in the concrete adapter init, command resolution, and per-command logic.
 * The `runLifecycle` function is intentionally generic over the adapter
 * shape so this module never imports the SDK.
 */

import { renderError, renderSuccess } from './renderers/index.js';
import { exitCodeFor } from './output/envelope.js';
import { CliError } from './types.js';
import type {
  CliProfile,
  CommandResult,
  ExitCode,
  ProviderCapabilities,
  RenderContext,
} from './types.js';

export interface LifecycleHooks<TFlags, TAdapter, TResult> {
  /** Validate parsed flags (zod) and the FilterExpr if present. */
  validate(flags: TFlags): Promise<void> | void;

  /** Static scope check — runs before adapter init. */
  staticScope(flags: TFlags, profile: CliProfile): void;

  /** Adapter construction. Receives the resolved profile + flags. */
  initAdapter(flags: TFlags, profile: CliProfile): Promise<TAdapter>;

  /** Capability loader. Receives the constructed adapter. */
  loadCapabilities(adapter: TAdapter): Promise<ProviderCapabilities>;

  /** Dynamic scope check — runs after capabilities load, before execute. */
  dynamicScope(
    flags: TFlags,
    profile: CliProfile,
    capabilities: ProviderCapabilities,
  ): void;

  /** Run the command. */
  execute(
    flags: TFlags,
    adapter: TAdapter,
    capabilities: ProviderCapabilities,
  ): Promise<CommandResult<TResult>>;
}

interface LifecycleInputs<TFlags> {
  flags: TFlags;
  profile: CliProfile;
  ctx: RenderContext;
  /**
   * --interactive / --no-interactive global flag. The lifecycle rejects
   * `--interactive` (true) when the resolved output mode is non-text.
   * `--no-interactive` (false) is honored silently for any mode.
   */
  interactiveHint: boolean | null;
}

/**
 * Runs the full lifecycle and returns the process exit code. Stdout/stderr
 * writes are owned by the renderer; this function never writes directly.
 */
export async function runLifecycle<TFlags, TAdapter, TResult>(
  inputs: LifecycleInputs<TFlags>,
  hooks: LifecycleHooks<TFlags, TAdapter, TResult>,
): Promise<ExitCode> {
  try {
    await hooks.validate(inputs.flags);
    hooks.staticScope(inputs.flags, inputs.profile);

    const adapter = await hooks.initAdapter(inputs.flags, inputs.profile);
    const capabilities = await hooks.loadCapabilities(adapter);
    hooks.dynamicScope(inputs.flags, inputs.profile, capabilities);

    if (inputs.interactiveHint === true && inputs.ctx.mode !== 'text') {
      throw new CliError(
        'usage',
        `--interactive is only valid when output mode is "text"; got "${inputs.ctx.mode}"`,
      );
    }

    const result = await hooks.execute(inputs.flags, adapter, capabilities);
    renderSuccess(inputs.ctx, result);
    return 0;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    renderError(inputs.ctx, error);
    return exitCodeFor(error);
  }
}
