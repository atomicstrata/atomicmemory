/** Real SDK HTTP fixture and deterministic AI SDK 6 model responses for tool tests. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { MemoryClient } from '@atomicmemory/sdk';
import { MockLanguageModelV3 } from 'ai/test';
import type { ToolExecutionOptions } from 'ai';
import { z } from 'zod/v3';

export const receipt = {
  embedding_provider: 'fixture', embedding_model: 'embedding',
  embedding_model_version: '1', embedding_dimensions: 3,
  query_text: 'drink', candidate_ids: ['tea'], trace_id: 'trace-1',
};
export const searchBody = {
  memories: [{ id: 'tea', content: 'Prefers tea', ranking_score: 2,
    semantic_similarity: 0.8, relevance: 0.7, version_id: null,
    observed_at: '2026-10-02T00:00:00Z', importance: 0.9,
    namespace: 'private', source_site: 'secret' }],
  count: 1, retrieval: { ...receipt, metadata: 'secret-receipt', apiKey: 'secret-api-key' },
};
export const ingestBody = { stored_memory_ids: ['new-1'], updated_memory_ids: ['old-1'] };
export const context: ToolExecutionOptions = { toolCallId: 'direct', messages: [] };

export async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return z.record(z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString()));
}

export async function fixture(
  respond?: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  timeout = 1000,
) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    requests.push({ path: request.url ?? '', body: await bodyOf(request) });
    if (respond) return respond(request, response);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url?.includes('search') ? searchBody : ingestBody));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const client = new MemoryClient({ providers: { atomicmemory: {
    apiUrl: `http://127.0.0.1:${address.port}`, apiKey: 'secret-api-key',
    allowPrivateNetworks: true, timeout,
  } } });
  await client.initialize();
  return { client, requests, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
export function modelResult(content: GenerateResult['content'], tools = false): GenerateResult {
  return { content, finishReason: { unified: tools ? 'tool-calls' : 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
}

export function toolModel(calls: { toolName: string; input: unknown }[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: [
    modelResult(calls.map((call, i) => ({ type: 'tool-call', toolCallId: `call-${i}`,
      toolName: call.toolName, input: JSON.stringify(call.input) })), true),
    modelResult([{ type: 'text', text: 'Memory checked.' }]),
  ] });
}
