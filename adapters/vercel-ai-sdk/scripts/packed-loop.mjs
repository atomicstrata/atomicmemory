/** Run a packed consumer's real AI SDK multistep flow through real SDK HTTP. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MemoryClient } from '@atomicmemory/sdk';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { memoryTools } from '@atomicmemory/vercel-ai-sdk/tools';

function result(content, tools = false) {
  return { content, warnings: [], finishReason: { unified: tools ? 'tool-calls' : 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 } } };
}

const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  response.setHeader('Content-Type', 'application/json');
  if (body.query === 'failure') {
    response.statusCode = 401; response.end('secret-backend-credentials'); return;
  }
  response.end(JSON.stringify(request.url.includes('search')
    ? { memories: [{ id: 'tea', content: 'Prefers tea', score: 2 }], count: 1 }
    : { stored_memory_ids: ['tea'], updated_memory_ids: [] }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');

try {
  const client = new MemoryClient({ providers: { atomicmemory: {
    apiUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetworks: true,
  } } });
  await client.initialize();
  const model = new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
    if (prompt.some(message => message.role === 'tool')) return result([{ type: 'text', text: 'Prefers tea.' }]);
    return result([
      { type: 'tool-call', toolCallId: 'search', toolName: 'memory_search', input: '{"query":"drink"}' },
      { type: 'tool-call', toolCallId: 'ingest', toolName: 'memory_ingest', input: '{"content":"tea"}' },
      { type: 'tool-call', toolCallId: 'error', toolName: 'memory_search', input: '{"query":"failure"}' },
    ], true);
  } });
  const generated = await generateText({ model, prompt: 'Remember tea', stopWhen: stepCountIs(2),
    tools: memoryTools({ client, scope: { user: 'alice' } }) });
  assert.equal(generated.text, 'Prefers tea.');
  assert.deepEqual(generated.steps[0].toolResults.map(part => part.output), [
    { results: [{ id: 'tea', content: 'Prefers tea', score: 2, rankingScore: 2, truncated: false }], truncated: false },
    { created: ['tea'], updated: [], unchanged: [] },
  ]);
  assert.equal(generated.steps[0].content.find(part => part.type === 'tool-error').error.message, 'Memory tool failed.');
  assert.doesNotMatch(JSON.stringify(model.doGenerateCalls[1].prompt), /secret-backend/);
  assert.deepEqual(requests, [
    { user_id: 'alice', query: 'drink', limit: 5 },
    { user_id: 'alice', conversation: 'tea', source_site: 'sdk', source_url: '' },
    { user_id: 'alice', query: 'failure', limit: 5 },
  ]);
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
