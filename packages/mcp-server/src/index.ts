/**
 * @file Public entry — re-exports the MCP server builder, the config
 *       loaders, and the tool schemas so downstream adapters can
 *       compose the server into richer runtimes without duplicating
 *       the Zod shapes.
 */

export { buildServer, sessionConfigFromBearer } from './server.js';
export type { BuildServerDeps } from './server.js';
export { loadConfigFromEnv, loadHostedHttpConfigFromEnv, validateConfig } from './config.js';
export type { ServerConfig, Scope } from './config.js';
export {
  resolveTransport,
  loadHttpListenConfig,
  DEFAULT_MCP_HTTP_PORT,
  DEFAULT_MCP_HTTP_HOST,
} from './http-listen.js';
export type { McpTransport, HttpListenConfig } from './http-listen.js';
export { startHttpServer } from './http-server.js';
export type { StartHttpServerOptions, RunningHttpServer } from './http-server.js';
export {
  extractBearerToken,
  requireBearerToken,
  createCloudApiKeyValidator,
  UnauthorizedError,
} from './auth.js';
export type { ApiKeyValidator } from './auth.js';
export {
  SearchArgsSchema,
  IngestArgsSchema,
  PackageArgsSchema,
  createHandlers,
} from './tools.js';
export type { SearchArgs, IngestArgs, PackageArgs } from './tools.js';
