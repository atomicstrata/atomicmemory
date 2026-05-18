/**
 * @file Public entry — re-exports the MCP server builder, the config
 *       loaders, and the tool schemas so downstream adapters can
 *       compose the server into richer runtimes without duplicating
 *       the Zod shapes.
 */

export { buildServer } from './server.js';
export { loadConfigFromEnv, validateConfig } from './config.js';
export type { ServerConfig, Scope } from './config.js';
export {
  SearchArgsSchema,
  IngestArgsSchema,
  PackageArgsSchema,
  createHandlers,
} from './tools.js';
export type { SearchArgs, IngestArgs, PackageArgs } from './tools.js';
