/**
 * @file Per-command agent sanitizers. The renderers/agent.ts pipeline
 * raises `runtime` for any command that lacks a registered sanitizer,
 * so V1 must register one for every command that advertises agent
 * output in cli-spec.json.
 *
 * For Phase 5, every V1 command ships a passthrough sanitizer: the
 * adapter layer already translates SDK shapes into CLI types, so the
 * data is agent-safe before it reaches here. Phase 8 / future
 * hardening can replace any of these with stricter selectors as the
 * product surface stabilizes.
 */

import { registerSanitizer } from '../envelope.js';
import { redactSecrets } from '../../commands/setup/hooks/sanitize.js';

const passthrough = <T>(input: T): T => input;

/**
 * Defensive hooks sanitizer. The hook command's `runUserPromptSubmit`
 * already runs retrieved memory contents through `sanitizePromptContext`,
 * but the agent envelope is the most-replayed surface (machine consumers
 * cache and chain it), so we re-run `redactSecrets` over any
 * `additionalContext` we encounter here as a belt-and-suspenders pass.
 * Lifecycle-write success cases (`data: ''`) and skip cases pass through
 * unchanged.
 */
const hooksSanitizer = (input: unknown): unknown => {
  if (!input || typeof input !== 'object') return input;
  const obj = input as Record<string, unknown>;
  const hookOutput = obj.hookSpecificOutput;
  if (!hookOutput || typeof hookOutput !== 'object') return input;
  const inner = hookOutput as Record<string, unknown>;
  if (typeof inner.additionalContext !== 'string') return input;
  return {
    ...obj,
    hookSpecificOutput: {
      ...inner,
      additionalContext: redactSecrets(inner.additionalContext),
    },
  };
};

const COMMANDS_WITH_AGENT_OUTPUT = [
  // setup
  'init',
  'doctor',
  'status',
  'version',
  'skill',
  'skill list',
  'skill get',
  'skill path',
  'validate',
  'help',
  // memory
  'add',
  'ingest',
  'search',
  'package',
  'list',
  'get',
  'delete',
  'import',
  // config
  'config show',
  'config get',
  'config set',
  'config unset',
  'config profile list',
  'config profile use',
  'config profile show',
  // hidden experimental commands — they still need sanitizers because
  // they can be invoked with --experimental and emit agent envelopes
  'lifecycle',
  'audit',
  'lessons',
  'agents',
] as const;

for (const name of COMMANDS_WITH_AGENT_OUTPUT) {
  registerSanitizer(name, passthrough);
}
registerSanitizer('hooks', hooksSanitizer);

export {};
