/**
 * @file In-process spawn entrypoint for plugin runtimes that embed the
 *       server directly (e.g. OpenClaw) instead of launching it as a
 *       subprocess via `bin.ts`. Returns the raw MCP `Server` plus a
 *       ready-to-use `MemoryClient` for hosts that want to call the SDK
 *       directly without going through the MCP transport.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { validateConfig } from './config.js';
import { buildServer } from './server.js';

export interface SpawnResult {
  server: Server;
}

/**
 * Build an MCP server from an explicit config object. Caller owns the
 * transport — attach a stdio, SSE, or in-memory transport as needed.
 */
export async function spawnAtomicMemoryMcp(input: unknown): Promise<SpawnResult> {
  const config = validateConfig(input);
  const server = await buildServer(config);
  return { server };
}
