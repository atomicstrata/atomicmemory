/** Tool behavior through real SDK HTTP requests and AI SDK 6 generation loops. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryClient } from '@atomicmemory/sdk';
import { generateText, stepCountIs, type ToolSet, type InferToolInput, type InferToolOutput } from 'ai';
import { memoryTools, type MemoryToolsScope } from './tools.js';
import { context, fixture, receipt, toolModel } from './tools-test-support.js';

test('AI SDK executes both tools, preserves evidence and uses snapshotted identity', async t => {
  const http = await fixture(); t.after(http.close);
  const options = { client: http.client, scope: { user: 'alice' } };
  const tools = memoryTools(options) satisfies ToolSet;
  options.scope.user = 'mallory';
  options.client = new MemoryClient({ providers: { atomicmemory: { apiUrl: 'http://unused.invalid' } } });
  options.scope = { user: 'another-user' };
  const model = toolModel([
    { toolName: 'memory_search', input: { query: 'drink' } },
    { toolName: 'memory_ingest', input: { content: 'Prefers tea' } },
  ]);
  const result = await generateText({ model, tools, prompt: 'Remember tea', stopWhen: stepCountIs(2) });
  assert.equal(result.text, 'Memory checked.');
  assert.deepEqual(result.steps[0]?.toolResults.map(part => part.output), [
    { results: [{ id: 'tea', content: 'Prefers tea', score: 2, similarity: 0.8,
      rankingScore: 2, relevance: 0.7, versionId: null,
      observedAt: '2026-10-02T00:00:00Z', truncated: false }], truncated: false,
      retrieval: { embeddingProvider: 'fixture', embeddingModel: 'embedding',
        embeddingModelVersion: '1', embeddingDimensions: 3, queryText: 'drink',
        candidateIds: ['tea'], traceId: 'trace-1' } },
    { created: ['new-1'], updated: ['old-1'], unchanged: [] },
  ]);
  assert.deepEqual(http.requests, [
    { path: '/v1/memories/search/fast', body: { user_id: 'alice', query: 'drink', limit: 5 } },
    { path: '/v1/memories/ingest', body: { user_id: 'alice', conversation: 'Prefers tea', source_site: 'sdk', source_url: '' } },
  ]);
  assert.match(JSON.stringify(model.doGenerateCalls[1]?.prompt), /new-1/);
  assert.doesNotMatch(JSON.stringify(model.doGenerateCalls[1]?.prompt), /secret|private|source_site/);
});

test('empty search preserves its real receipt rather than fabricating evidence', async t => {
  const http = await fixture(async (_request, response) => {
    response.end(JSON.stringify({ memories: [], count: 0, retrieval: { ...receipt, candidate_ids: [] } }));
  }); t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  assert(tools.memory_search.execute);
  const output = await tools.memory_search.execute({ query: 'drink', limit: 1 }, context);
  assert.deepEqual(output, { results: [], truncated: false, retrieval: {
    embeddingProvider: 'fixture', embeddingModel: 'embedding', embeddingModelVersion: '1',
    embeddingDimensions: 3, queryText: 'drink', candidateIds: [], traceId: 'trace-1',
  } });
  assert.deepEqual(http.requests[0]?.body, { user_id: 'alice', query: 'drink', limit: 1 });
});

test('concrete input/output types work with the real ToolSet', async t => {
  const http = await fixture(); t.after(http.close);
  const scope: MemoryToolsScope = { user: 'alice' };
  const tools = memoryTools({ client: http.client, scope }) satisfies ToolSet;
  // @ts-expect-error Trusted scope is readonly in the public contract.
  scope.user = 'other';
  const search: InferToolInput<typeof tools.memory_search> = { query: 'drink' };
  assert(tools.memory_search.execute);
  const executed = await tools.memory_search.execute(search, context);
  assert('results' in executed);
  const output: InferToolOutput<typeof tools.memory_search> = executed;
  assert.equal(output.results[0]?.content, 'Prefers tea');
  assert.deepEqual(http.requests[0]?.body, { user_id: 'alice', query: 'drink', limit: 5 });
  // @ts-expect-error Identity cannot be supplied by the model.
  const bad: InferToolInput<typeof tools.memory_ingest> = { content: 'tea', scope: { user: 'other' } };
  assert.equal(bad.content, 'tea');
});
