/** Run a packed consumer's real AI SDK multistep flow through real SDK HTTP. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateText, stepCountIs, streamText } from 'ai';
import { createMemory } from '@atomicmemory/vercel-ai/tools';

// AI SDK 5, 6, and 7 consume provider protocol versions 2, 3, and 4 respectively.
// Use a plain provider fixture: some AI SDK 5 patches' test entry imports undeclared dependencies.
const modelVersion = Number(process.env.AI_SDK_VERSION.split('.')[0]) - 3;
process.env.ATOMICMEMORY_API_KEY = 'fixture-cloud-key';

function result(content, tools = false) {
  const reason = tools ? 'tool-calls' : 'stop';
  if (modelVersion === 2) return { content, warnings: [], finishReason: reason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  return { content, warnings: [], finishReason: { unified: reason, raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 } } };
}

function sortRequests(requests) {
  return [...requests].sort((left, right) =>
    (left.query ?? left.conversation).localeCompare(right.query ?? right.conversation));
}

async function verifyStream(model, tools) {
  const streamed = streamText({ model, prompt: 'Recall tea', tools, stopWhen: stepCountIs(1) });
  const parts = [];
  for await (const part of streamed.fullStream) parts.push(part);
  const output = parts.find(part => part.type === 'tool-result' && part.toolCallId === 'stream-search');
  assert.equal(output?.output.results[0]?.content, 'Prefers tea');
  const saved = parts.find(part => part.type === 'tool-result' && part.toolName === 'memory_ingest');
  assert.deepEqual(saved?.output.created, ['tea']);
  const failure = parts.find(part => part.type === 'tool-error' && part.toolCallId === 'stream-error');
  assert.ok(failure, 'Expected the failed stream call to produce a tool-error part');
  assert.equal(failure.error.message, 'Memory tool failed.');
  assert.equal(failure.error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(parts), /secret-backend-credentials/);
}

const requests = [];
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer fixture-core-key');
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
  const memory = await createMemory({
    backend: 'local', url: ` http://127.0.0.1:${address.port} `, apiKey: 'fixture-core-key\n',
  });
  assert.deepEqual(Object.keys(memory.toolsForUser('alice')), ['memory_search']);
  const prompts = [];
  const model = {
    specificationVersion: `v${modelVersion}`,
    provider: 'fixture',
    modelId: 'memory-tools',
    supportedUrls: {},
    async doGenerate({ prompt }) {
      prompts.push(prompt);
      if (prompt.some(message => message.role === 'tool')) return result([{ type: 'text', text: 'Prefers tea.' }]);
      return result([
        { type: 'tool-call', toolCallId: 'search', toolName: 'memory_search', input: '{"query":"drink"}' },
        { type: 'tool-call', toolCallId: 'ingest', toolName: 'memory_ingest', input: '{"content":"tea"}' },
        { type: 'tool-call', toolCallId: 'error', toolName: 'memory_search', input: '{"query":"failure"}' },
      ], true);
    },
    async doStream() {
      const { usage, finishReason } = result([], true);
      const parts = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'stream-search', toolName: 'memory_search', input: '{"query":"drink"}' },
        { type: 'tool-call', toolCallId: 'stream-save', toolName: 'memory_ingest', input: '{"content":"tea"}' },
        { type: 'tool-call', toolCallId: 'stream-error', toolName: 'memory_search', input: '{"query":"failure"}' },
        { type: 'finish', usage, finishReason },
      ];
      return { stream: ReadableStream.from(parts) };
    },
  };
  const generated = await generateText({ model, prompt: 'Remember tea', stopWhen: stepCountIs(2),
    tools: memory.toolsForUser('alice', { allowWrites: true }) });
  assert.equal(generated.text, 'Prefers tea.');
  assert.deepEqual(generated.steps[0].toolResults.map(part => part.output), [
    { results: [{ id: 'tea', content: 'Prefers tea', score: 2, rankingScore: 2, truncated: false }], truncated: false },
    { created: ['tea'], updated: [], unchanged: [] },
  ]);
  assert.equal(generated.steps[0].content.find(part => part.type === 'tool-error').error.message, 'Memory tool failed.');
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(JSON.stringify(prompts[1]), /secret-backend/);
  assert.deepEqual(sortRequests(requests), [
    { user_id: 'alice', query: 'drink', limit: 5 },
    { user_id: 'alice', query: 'failure', limit: 5 },
    { user_id: 'alice', conversation: 'tea', source_site: 'sdk', source_url: '' },
  ]);
  await verifyStream(model, memory.toolsForUser('bob', { allowWrites: true }));
  assert.deepEqual(sortRequests(requests.slice(3)), [
    { user_id: 'bob', query: 'drink', limit: 5 },
    { user_id: 'bob', query: 'failure', limit: 5 },
    { user_id: 'bob', conversation: 'tea', source_site: 'sdk', source_url: '' },
  ]);
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
