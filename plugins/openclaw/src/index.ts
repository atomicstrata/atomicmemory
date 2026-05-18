/**
 * @file OpenClaw plugin entry. OpenClaw plugins register tools directly,
 *       while the other AtomicMemory agent integrations speak MCP. This
 *       adapter embeds the shared MCP server in-process, then exposes its
 *       four memory tools through OpenClaw's `registerTool` contract so
 *       memory semantics stay owned by `@atomicmemory/mcp-server`.
 */

import { createEmbeddedMcpToolCaller } from '@atomicmemory/mcp-server/embedded-client';
import { hostname, userInfo } from 'node:os';

interface AtomicMemoryConfig {
  apiUrl?: string;
  apiKey?: string;
  /** Provider name dispatched through the SDK's MemoryProvider model. */
  provider?: 'atomicmemory' | 'mem0';
  scope?: { user?: string; agent?: string; namespace?: string; thread?: string };
}

interface PluginApi {
  pluginConfig?: AtomicMemoryConfig;
  registerTool(tool: AgentTool, options?: { name?: string; names?: string[] }): void;
}

interface Plugin {
  id: string;
  name: string;
  description: string;
  kind: 'memory';
  register(api: PluginApi): void;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
}

interface McpToolCaller {
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: unknown }>;
}

type CreateMcpToolCaller = (
  config: unknown,
  clientInfo: { name: string; version: string },
) => Promise<McpToolCaller>;

type McpClientFactory = () => Promise<McpToolCaller>;

interface McpTextContent {
  type: 'text';
  text: string;
}

const TOOL_NAMES = ['memory_search', 'memory_ingest', 'memory_package', 'memory_list'] as const;

export function createOpenClawPlugin(createCaller: CreateMcpToolCaller = createEmbeddedMcpToolCaller): Plugin {
  return {
    id: 'atomicmemory',
    name: 'AtomicMemory',
    description: 'Persistent semantic memory for OpenClaw agents.',
    kind: 'memory',
    register(api: PluginApi): void {
      const client = lazyMcpClient(api.pluginConfig ?? {}, createCaller);
      for (const name of TOOL_NAMES) {
        api.registerTool(createTool(name, client));
      }
    },
  };
}

function lazyMcpClient(config: AtomicMemoryConfig, createCaller: CreateMcpToolCaller): McpClientFactory {
  let client: Promise<McpToolCaller> | undefined;
  return () => {
    client ??= createMcpClient(config, createCaller);
    return client;
  };
}

async function createMcpClient(config: AtomicMemoryConfig, createCaller: CreateMcpToolCaller) {
  return createCaller(normalizeConfig(config), {
    name: 'atomicmemory-openclaw',
    version: '0.1.0',
  });
}

function createTool(name: (typeof TOOL_NAMES)[number], client: McpClientFactory): AgentTool {
  return {
    name,
    label: labelFor(name),
    description: descriptionFor(name),
    parameters: schemaFor(name),
    async execute(_toolCallId, params) {
      const caller = await client();
      const result = await caller.callTool({ name, arguments: params });
      return openClawResult(result.content);
    },
  };
}

function openClawResult(content: unknown): ToolResult {
  const text = textContent(content);
  return {
    content: [{ type: 'text', text }],
    details: parseDetails(text),
  };
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  const first = content.find((item): item is McpTextContent => isTextContent(item));
  return first?.text ?? JSON.stringify(content);
}

function isTextContent(value: unknown): value is McpTextContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

function parseDetails(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function schemaFor(name: (typeof TOOL_NAMES)[number]): Record<string, unknown> {
  switch (name) {
    case 'memory_search':
      return objectSchema({ query: stringSchema(), limit: optionalNumberSchema(), scope: scopeSchema() }, ['query']);
    case 'memory_ingest':
      return objectSchema({
        mode: enumSchema(['text', 'messages', 'verbatim']),
        content: stringSchema(),
        messages: { type: 'array' },
        scope: scopeSchema(),
        metadata: { type: 'object', additionalProperties: true },
        provenance: { type: 'object', additionalProperties: true },
      }, ['mode']);
    case 'memory_package':
      return objectSchema({ query: stringSchema(), tokenBudget: optionalNumberSchema(), scope: scopeSchema() }, ['query']);
    case 'memory_list':
      return objectSchema({ limit: optionalNumberSchema(), scope: scopeSchema() }, []);
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required };
}

function scopeSchema(): Record<string, unknown> {
  return objectSchema({
    user: stringSchema(),
    agent: stringSchema(),
    namespace: stringSchema(),
    thread: stringSchema(),
  }, []);
}

function stringSchema(): Record<string, unknown> {
  return { type: 'string' };
}

function optionalNumberSchema(): Record<string, unknown> {
  return { type: 'number' };
}

function enumSchema(values: string[]): Record<string, unknown> {
  return { type: 'string', enum: values };
}

function labelFor(name: (typeof TOOL_NAMES)[number]): string {
  return {
    memory_search: 'Memory Search',
    memory_ingest: 'Memory Ingest',
    memory_package: 'Memory Package',
    memory_list: 'Memory List',
  }[name];
}

function descriptionFor(name: (typeof TOOL_NAMES)[number]): string {
  return {
    memory_search: 'Search AtomicMemory by meaning.',
    memory_ingest: 'Store durable memory through AtomicMemory.',
    memory_package: 'Assemble a token-budgeted AtomicMemory context package.',
    memory_list: 'List recent memories for the configured scope.',
  }[name];
}

function normalizeConfig(config: AtomicMemoryConfig): {
  apiUrl: string;
  apiKey?: string;
  provider: 'atomicmemory' | 'mem0';
  scope: { user: string; agent?: string; namespace?: string; thread?: string };
} {
  const provider = config.provider ?? 'atomicmemory';
  const scope = normalizeScope(config.scope);
  const apiKey = cleanOptional(config.apiKey);
  const result = { apiUrl: resolveApiUrl(config.apiUrl, provider), provider, scope };

  if (apiKey) return { ...result, apiKey };
  return result;
}

function normalizeScope(scope: AtomicMemoryConfig['scope']): {
  user: string;
  agent?: string;
  namespace?: string;
  thread?: string;
} {
  const user = cleanOptional(scope?.user) ?? defaultScopeUser();
  const result: { user: string; agent?: string; namespace?: string; thread?: string } = { user };
  const agent = cleanOptional(scope?.agent);
  const namespace = cleanOptional(scope?.namespace);
  const thread = cleanOptional(scope?.thread);

  if (agent) result.agent = agent;
  if (namespace) result.namespace = namespace;
  if (thread) result.thread = thread;
  return result;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function defaultScopeUser(): string {
  return (
    cleanOptional(process.env.USER) ??
    cleanOptional(process.env.USERNAME) ??
    readOsUsername() ??
    cleanOptional(hostname()) ??
    'local-machine'
  );
}

function resolveApiUrl(apiUrl: string | undefined, provider: 'atomicmemory' | 'mem0'): string {
  const normalized = cleanOptional(apiUrl);
  if (normalized) return normalized.replace(/\/+$/, '');
  if (provider === 'atomicmemory') return 'http://127.0.0.1:3050';
  throw new Error('AtomicMemory OpenClaw plugin requires config.apiUrl when provider=mem0');
}

function readOsUsername(): string | undefined {
  try {
    return cleanOptional(userInfo().username);
  } catch {
    return undefined;
  }
}

export default createOpenClawPlugin();
