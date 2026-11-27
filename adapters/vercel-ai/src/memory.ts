/** Server setup for AI SDK memory tools with a shared client and per-user permissions. */
import { memoryTools, type MemoryTools, type MemoryToolsClient } from './tools.js';

/** Select Cloud or local Core explicitly, or supply an initialized client. */
export type CreateMemoryOptions =
  | { backend: 'cloud' }
  | { backend: 'local'; /** Trusted server configuration, not request or model input. */ url: string; apiKey: string }
  | { client: MemoryToolsClient };

/** Search is available by default; writes are enabled only by the application. */
export type ReadOnlyMemoryTools = Pick<MemoryTools, 'memory_search'>;

/** A shared memory connection that creates fresh tools for each authenticated user. */
export interface Memory {
  toolsForUser(user: string, options: { allowWrites: true }): MemoryTools;
  toolsForUser(user: string, options?: { allowWrites?: false }): ReadOnlyMemoryTools;
  toolsForUser(user: string, options: { allowWrites: boolean }): ReadOnlyMemoryTools | MemoryTools;
}

/** Initialize once on the server and use the returned connection for subsequent requests. */
export async function createMemory(options: CreateMemoryOptions): Promise<Memory> {
  if ('window' in globalThis || !globalThis.process?.versions?.node) {
    throw new Error('Create AtomicMemory tools on the Node.js server.');
  }
  if (!options || typeof options !== 'object') {
    throw new Error('Choose a memory backend or pass an initialized client.');
  }
  if ('client' in options && ('backend' in options || 'url' in options || 'apiKey' in options)) {
    throw new Error('Pass an initialized client or backend settings, not both.');
  }
  const client = 'client' in options ? options.client : await openClient(options);
  function toolsForUser(user: string, policy: { allowWrites: true }): MemoryTools;
  function toolsForUser(user: string, policy?: { allowWrites?: false }): ReadOnlyMemoryTools;
  function toolsForUser(user: string, policy: { allowWrites: boolean }): ReadOnlyMemoryTools | MemoryTools;
  function toolsForUser(user: string, policy?: { allowWrites?: boolean }): ReadOnlyMemoryTools | MemoryTools {
    const tools = memoryTools({ client, scope: { user } });
    return policy?.allowWrites === true ? tools : { memory_search: tools.memory_search };
  }
  return { toolsForUser };
}

async function openClient(options: Exclude<CreateMemoryOptions, { client: MemoryToolsClient }>) {
  if (options.backend !== 'cloud' && options.backend !== 'local') {
    throw new Error('Choose a memory backend or pass an initialized client.');
  }
  if (options.backend === 'cloud' && ('url' in options || 'apiKey' in options)) {
    throw new Error('Core URL and token require the local backend.');
  }
  const config = options.backend === 'local' ? localConfig(options) : undefined;
  const { MemoryClient } = await import('@atomicmemory/sdk');
  const client = new MemoryClient(config);
  await client.initialize();
  return client;
}

function localConfig(options: Extract<CreateMemoryOptions, { backend: 'local' }>) {
  const apiUrl = options.url?.trim();
  const apiKey = options.apiKey?.trim();
  if (!apiUrl || !apiKey) throw new Error('Local Core requires its server URL and Core token.');
  return { providers: { atomicmemory: { apiUrl, apiKey, allowPrivateNetworks: true } } };
}
