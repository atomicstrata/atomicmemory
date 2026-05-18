/**
 * @file Public entry - LangGraph JS adapter for AtomicMemory.
 *
 *       Two surfaces:
 *
 *       1. Framework-agnostic helpers around an injected
 *          `MemoryClient` (`searchMemory`, `ingestTurn`,
 *          `defaultFormatter`).
 *
 *       2. Node factories that produce plain async
 *          `(state) => Partial<state>` functions you can use as
 *          LangGraph nodes:
 *            - `createMemoryRetrieveNode()` - searches before
 *              the next inference step and merges the rendered
 *              context back into state.
 *            - `createMemoryIngestNode()` - persists the
 *              completed turn after the model call.
 *
 *       The factories never import `@langchain/langgraph` at
 *       runtime; they emit plain async functions. The peer
 *       declaration documents the intended consumer.
 */

export { searchMemory, defaultFormatter } from './search.js';
export type { SearchMemoryOptions, SearchMemoryResult } from './search.js';

export { ingestTurn } from './ingest.js';
export type { IngestTurnOptions } from './ingest.js';

export { createMemoryRetrieveNode, createMemoryIngestNode } from './nodes.js';
export type {
  CreateMemoryRetrieveNodeOptions,
  CreateMemoryIngestNodeOptions,
  MemoryRetrieveNode,
  MemoryIngestNode,
} from './nodes.js';
