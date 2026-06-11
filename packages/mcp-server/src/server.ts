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
import { EntitiesClient } from '@atomicmemory/sdk';
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
      'Save durable memory. Use mode=text or mode=messages for extraction, and mode=verbatim for one-input-one-record deterministic lifecycle records. For mode=verbatim, set contentClass (summary|redacted|raw) describing what you are storing: a core with the default raw-content policy rejects unstamped or raw content, so distil to a summary or redact sensitive spans rather than sending a raw transcript.',
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
        contentClass: {
          type: 'string',
          enum: ['summary', 'redacted', 'raw'],
          description:
            "Only valid with mode='verbatim'. Supplying it on text/messages is rejected, since those run core-side extraction and do not carry a content class.",
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
  {
    name: 'entity_profile',
    description:
      'Get the synthesized profile for a user or agent — summary, preferences, instructions, ' +
      'open commitments, and structured attribute triples. Call when you need a quick structured ' +
      'overview of what AtomicMemory knows about a specific person.',
    inputSchema: {
      type: 'object',
      required: ['entityId'],
      additionalProperties: false,
      properties: {
        entityId: { type: 'string', minLength: 1, description: 'User or agent identifier.' },
        entityType: { type: 'string', enum: ['user', 'agent', 'session'], description: 'Defaults to user.' },
      },
    },
  },
  {
    name: 'entity_attributes',
    description:
      'Get structured (entity, attribute, value) triples extracted from memories. ' +
      'Useful for precise factual lookups — "what is Alice\'s role?" — without running a full search.',
    inputSchema: {
      type: 'object',
      required: ['entityId'],
      additionalProperties: false,
      properties: {
        entityId: { type: 'string', minLength: 1, description: 'User or agent identifier.' },
        entityType: { type: 'string', enum: ['user', 'agent', 'session'], description: 'Defaults to user.' },
        attribute: { type: 'string', description: 'Filter by attribute key (e.g. "role", "timezone").' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
] as const;

export async function buildServer(config: ServerConfig): Promise<Server> {
  const client = await initClient(config);
  const handlers = createHandlers(client, config.scope);
  const entities = initEntitiesClient(config);

  const server = new Server(
    { name: 'atomicmemory', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatch(handlers, entities, req.params.name, req.params.arguments);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  return server;
}

function initEntitiesClient(config: ServerConfig): EntitiesClient | null {
  if (!config.apiKey) return null;
  return new EntitiesClient({ apiUrl: config.apiUrl, apiKey: config.apiKey });
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
  entities: EntitiesClient | null,
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
    case 'entity_profile': {
      if (!entities) throw new Error('entity_profile requires ATOMICMEMORY_API_KEY');
      const { entityId, entityType = 'user' } = args as { entityId: string; entityType?: 'user' | 'agent' | 'session' };
      return entities.profile(entityId, entityType);
    }
    case 'entity_attributes': {
      if (!entities) throw new Error('entity_attributes requires ATOMICMEMORY_API_KEY');
      const { entityId, entityType = 'user', attribute, limit } = args as {
        entityId: string;
        entityType?: 'user' | 'agent' | 'session';
        attribute?: string;
        limit?: number;
      };
      const attrOpts = { ...(attribute !== undefined && { attribute }), ...(limit !== undefined && { limit }) };
      return entities.attributes(entityId, attrOpts, entityType);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
