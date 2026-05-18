/**
 * @file Public entry for the OpenAI Agents SDK adapter.
 *
 * The adapter keeps memory wiring explicit and composable:
 * - `augmentInputWithMemory()` searches before `run()` and prepends a
 *   system message containing retrieved context.
 * - `ingestAgentTurn()` persists completed turns after `run()`.
 * - `runWithMemory()` composes the two around any Agents SDK runner.
 * - `createMemoryTools()` exposes `memory_search` and `memory_ingest`
 *   as OpenAI Agents SDK function tools.
 */

export { augmentInputWithMemory, defaultFormatter } from './augment.js';
export type { AugmentInputOptions, AugmentInputResult } from './augment.js';

export {
  agentInputToMessages,
  agentInputToText,
  normalizeAgentInput,
  resultOutputToText,
} from './messages.js';
export type { AgentInputLike, RunResultLike } from './messages.js';

export { ingestAgentTurn } from './ingest.js';
export type { IngestAgentTurnOptions } from './ingest.js';

export { runWithMemory } from './run-with-memory.js';
export type { RunWithMemoryOptions, RunWithMemoryResult } from './run-with-memory.js';

export { createMemoryTools } from './tools.js';
export type { CreateMemoryToolsOptions } from './tools.js';
