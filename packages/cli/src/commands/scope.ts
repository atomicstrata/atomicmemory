/**
 * @file Helpers commands use to enforce the v5 two-stage scope contract:
 *
 *   - requireScope: called BEFORE provider init (the lifecycle's static
 *     stage already runs assertStaticScope; commands re-narrow the
 *     resolved scope to a fully-typed CliScope here).
 *   - requireDynamicScope: called AFTER capabilities load to enforce
 *     `Capabilities.requiredScope` (operation-specific or default).
 *
 * Both surface CliError with the right code/exit so renderers do the
 * standard error envelope.
 */

import {
  assertDynamicScope,
  intoCliScope,
} from '../config/resolve.js';
import type {
  CliScope,
  ProviderCapabilities,
} from '../types.js';
import type { CommandContext } from './types.js';

/** Narrow ctx.scope to a CliScope after the static stage has run. */
export function requireScope(ctx: CommandContext): CliScope {
  return intoCliScope(ctx.scope);
}

/** Run dynamic-stage scope check using freshly-loaded capabilities. */
export function requireDynamicScope(
  ctx: CommandContext,
  operation: string,
  capabilities: ProviderCapabilities,
): void {
  assertDynamicScope(ctx.scope, operation, capabilities);
}
