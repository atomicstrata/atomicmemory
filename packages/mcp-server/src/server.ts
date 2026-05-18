/**
 * @file MCP server assembly — wires MemoryClient + tool handlers into a
 *       `@modelcontextprotocol/sdk` server. The server is transport-
 *       agnostic here; `bin.ts` wraps it in a stdio transport for CLI
 *       spawning, and `spawn.ts` exposes an in-process factory for
 *       plugin runtimes (e.g. OpenClaw) that embed the server without
 *       a subprocess.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryClient, type MemoryClientConfig } from '@atomicmemory/sdk/browser';
import type { ServerConfig } from './config.js';
import {
  createHandlers,
  IngestArgsSchema,
  ListArgsSchema,
  PackageArgsSchema,
  SearchArgsSchema,
} from './tools.js';

const SCOPE_PROPS = {
  user: { type: 'string' },
  agent: { type: 'string' },
  namespace: { type: 'string' },
  thread: { type: 'string' },
} as const;

const METADATA_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

const PROVENANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string' },
    sourceUrl: { type: 'string' },
    sourceId: { type: 'string' },
    extractor: { type: 'string' },
  },
} as const;

const TOOL_DEFINITIONS = [
  {
    name: 'memory_search',
    description:
      'Semantic search over persistent memory. Call before answering questions that reference prior context, past decisions, or user preferences.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1 },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: SCOPE_PROPS,
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        sourceSite: {
          type: 'string',
          minLength: 1,
          description:
            'Optional provenance filter. AtomicMemory provider only — non-AtomicMemory providers reject with PROVIDER_UNSUPPORTED rather than silently drop the filter.',
        },
      },
    },
  },
  {
    name: 'memory_ingest',
    description:
      'Save durable memory. Use mode=text or mode=messages for extraction, and mode=verbatim for one-input-one-record deterministic lifecycle records.',
    inputSchema: {
      type: 'object',
      required: ['mode'],
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['text', 'messages', 'verbatim'] },
        content: { type: 'string' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['role', 'content'],
            additionalProperties: false,
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
              content: { type: 'string' },
            },
          },
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: SCOPE_PROPS,
        },
        metadata: METADATA_SCHEMA,
        provenance: PROVENANCE_SCHEMA,
        kind: {
          type: 'string',
          enum: ['fact', 'episode', 'summary', 'procedure', 'document'],
        },
      },
    },
  },
  {
    name: 'memory_package',
    description:
      'Assemble a token-budgeted context package for a query — AtomicMemory selects and formats the most relevant memories to drop into a system prompt.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1 },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: SCOPE_PROPS,
        },
        tokenBudget: { type: 'integer', minimum: 1 },
        sourceSite: {
          type: 'string',
          minLength: 1,
          description:
            'Optional provenance filter. AtomicMemory provider only — non-AtomicMemory providers reject with PROVIDER_UNSUPPORTED rather than silently drop the filter.',
        },
      },
    },
  },
  {
    name: 'memory_list',
    description:
      'List recent memories for the configured scope. Supports an optional sourceSite provenance filter for surfacing per-tool memory partitions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: SCOPE_PROPS,
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        sourceSite: {
          type: 'string',
          minLength: 1,
          description:
            'Optional provenance filter. AtomicMemory provider only — non-AtomicMemory providers reject with PROVIDER_UNSUPPORTED rather than silently drop the filter.',
        },
      },
    },
  },
] as const;

export async function buildServer(config: ServerConfig): Promise<Server> {
  const client = await initClient(config);
  const handlers = createHandlers(client, config.scope);

  const server = new Server(
    { name: 'atomicmemory', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatch(handlers, req.params.name, req.params.arguments);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  return server;
}

async function initClient(config: ServerConfig): Promise<MemoryClient> {
  const providerConfig = {
    apiUrl: config.apiUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  };
  const providers: MemoryClientConfig['providers'] =
    config.provider === 'mem0'
      ? { mem0: providerConfig }
      : { atomicmemory: providerConfig };
  const client = new MemoryClient({ providers, defaultProvider: config.provider });
  await client.initialize();
  return client;
}

async function dispatch(
  handlers: ReturnType<typeof createHandlers>,
  name: string,
  args: unknown,
): Promise<unknown> {
  switch (name) {
    case 'memory_search':
      return handlers.memory_search(SearchArgsSchema.parse(args));
    case 'memory_ingest':
      return handlers.memory_ingest(IngestArgsSchema.parse(args));
    case 'memory_package':
      return handlers.memory_package(PackageArgsSchema.parse(args));
    case 'memory_list':
      return handlers.memory_list(ListArgsSchema.parse(args));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
