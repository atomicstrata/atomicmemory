/**
 * @file Public entry - Mastra adapter for AtomicMemory.
 *
 *       Two surfaces:
 *
 *       1. Framework-agnostic helpers around an injected
 *          `MemoryClient` (`searchMemory`, `ingestTurn`,
 *          `defaultFormatter`).
 *
 *       2. `createMemoryTools(client, opts)` - produces two
 *          Mastra `createTool()` instances (`memory_search` and
 *          `memory_ingest`) that any Mastra `Agent` can
 *          register.
 *
 *       `@mastra/core` and `zod` are declared as peerDependencies
 *       so consumers pin compatible versions alongside the rest
 *       of their Mastra app.
 */

export { searchMemory, defaultFormatter } from './search.js';
export type { SearchMemoryOptions, SearchMemoryResult } from './search.js';

export { ingestTurn } from './ingest.js';
export type { IngestTurnOptions } from './ingest.js';

export { createMemoryTools } from './tools.js';
export type { CreateMemoryToolsOptions, MemoryTools } from './tools.js';
