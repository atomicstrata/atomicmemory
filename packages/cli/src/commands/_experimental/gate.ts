/**
 * @file Two-stage gate every hidden experimental command runs in this
 * fixed order:
 *
 *   1. assertExperimentalEnabled  -> CliError('experimental_disabled')
 *   2. assertCapability(adapter, '<exact-extension-name>')
 *      -> CliError('unsupported_capability')
 *
 * The result is that an invocation against `provider=mem0` (no
 * AtomicMemory custom extensions) yields experimental_disabled when
 * --experimental is omitted, and unsupported_capability once the user
 * adds the flag. Phase 4 maps the per-command extension exactly:
 *
 *   lifecycle -> customExtensions.atomicmemory.lifecycle
 *   audit     -> customExtensions.atomicmemory.audit
 *   lessons   -> customExtensions.atomicmemory.lessons
 *   agents    -> customExtensions.atomicmemory.agents
 *
 * `runtime` is intentionally absent from v5 (no matching SDK extension).
 */

import {
  assertCapability,
  assertExperimentalEnabled,
} from '../../capability-gate.js';
import type { ProviderCapabilities } from '../../types.js';
import type { CommandContext } from '../types.js';

type ExperimentalSurface =
  | 'lifecycle'
  | 'audit'
  | 'lessons'
  | 'agents';

const EXTENSION_BY_SURFACE: Record<ExperimentalSurface, `customExtensions.${string}`> = {
  lifecycle: 'customExtensions.atomicmemory.lifecycle',
  audit: 'customExtensions.atomicmemory.audit',
  lessons: 'customExtensions.atomicmemory.lessons',
  agents: 'customExtensions.atomicmemory.agents',
};

export function gate(
  ctx: CommandContext,
  surface: ExperimentalSurface,
  capabilities: ProviderCapabilities,
): void {
  assertExperimentalEnabled({ experimental: ctx.experimental });
  assertCapability(capabilities, EXTENSION_BY_SURFACE[surface], surface);
}
