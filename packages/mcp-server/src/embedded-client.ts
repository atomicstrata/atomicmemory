/**
 * @file Embedded MCP client helper for host plugins that cannot speak
 *       MCP over stdio directly. The shared MCP server still owns tool
 *       semantics; this helper just wires an in-memory MCP client to it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { spawnAtomicMemoryMcp } from './spawn.js';

export interface EmbeddedMcpToolCaller {
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: unknown }>;
  close(): Promise<void>;
}

export async function createEmbeddedMcpToolCaller(
  config: unknown,
  clientInfo: { name: string; version: string },
): Promise<EmbeddedMcpToolCaller> {
  const { server } = await spawnAtomicMemoryMcp(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(clientInfo);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    callTool(input) {
      return client.callTool(input) as Promise<{ content: unknown }>;
    },
    close() {
      return client.close();
    },
  };
}
