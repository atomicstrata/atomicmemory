/**
 * @file Public entry - LangChain JS adapter for AtomicMemory.
 *
 *       Two surfaces:
 *
 *       1. Framework-agnostic helpers around an injected
 *          `MemoryClient` (`searchMemory`, `ingestTurn`,
 *          `defaultFormatter`) - usable inside any LangChain
 *          callback, RunnableLambda, or LCEL chain step.
 *
 *       2. `createMemoryTools(client, opts)` - builds two
 *          `@langchain/core/tools` `tool()` instances
 *          (`memory_search` and `memory_ingest`) that an
 *          agent (e.g. `createToolCallingAgent`, LangGraph's
 *          tool node) can call directly.
 *
 *       The adapter NEVER imports `langchain`; it imports
 *       `@langchain/core/tools` only inside the tool-factory
 *       module, and that package is declared as a
 *       peerDependency so consumers can pick a compatible
 *       LangChain version.
 */

export { searchMemory, defaultFormatter } from './search.js';
export type { SearchMemoryOptions, SearchMemoryResult } from './search.js';

export { ingestTurn } from './ingest.js';
export type { IngestTurnOptions } from './ingest.js';

export { createMemoryTools } from './tools.js';
export type { CreateMemoryToolsOptions, MemoryTools } from './tools.js';
