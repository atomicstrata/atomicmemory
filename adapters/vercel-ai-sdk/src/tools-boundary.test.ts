/** Enumerated bypass, failure and cancellation tests for both public tools. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateText, stepCountIs } from 'ai';
import { memoryTools, type MemoryTools } from './tools.js';
import { context, fixture, ingestBody, searchBody, toolModel } from './tools-test-support.js';

const cases = [
  { name: 'memory_search', input: { query: 'drink' } },
  { name: 'memory_ingest', input: { content: 'tea' } },
] as const;

async function execute(tools: MemoryTools, name: keyof MemoryTools, input: unknown, signal?: AbortSignal) {
  const callback = tools[name].execute;
  assert(callback);
  return await Reflect.apply(callback, undefined, [input, { ...context, ...(signal ? { abortSignal: signal } : {}) }]);
}

test('rejects unsupported config and scope, including reserved Cloud subjects', async t => {
  const http = await fixture(); t.after(http.close);
  for (const scope of [undefined, {}, { user: '' }, { user: '  ' }, { user: 'x'.repeat(257) },
    { user: 'project:abc' }, { user: ' project:abc' },
    ...['thread', 'agent', 'namespace', 'apiKey'].map(key => ({ user: 'alice', [key]: 'other' }))]) {
    assert.throws(() => Reflect.apply(memoryTools, undefined, [{ client: http.client, scope }]),
      { message: 'Memory tools configuration is invalid.' });
  }
  assert.throws(() => Reflect.apply(memoryTools, undefined, [{ client: http.client, scope: { user: 'alice' }, limit: 20 }]),
    { message: 'Memory tools configuration is invalid.' });
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  assert.deepEqual(await execute(tools, 'memory_ingest', { content: 'tea' }),
    { created: ['new-1'], updated: ['old-1'], unchanged: [] });
  assert.equal(http.requests.length, 1);
});

test('every tool rejects direct-call identity, credentials and parameter bypasses', async t => {
  const http = await fixture(); t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  assert.deepEqual(Object.keys(tools).sort(), ['memory_ingest', 'memory_search']);
  for (const { name, input } of cases) {
    for (const key of ['scope', 'user', 'thread', 'agent', 'namespace', 'apiKey', 'apiUrl',
      'client', 'params', 'filter', 'threshold', 'reranker', 'signal', 'metadata', 'provenance', '__proto__']) {
      await assert.rejects(() => execute(tools, name, { ...input, [key]: { user: 'other' } }),
        { message: 'Memory tool failed.' });
    }
    await execute(tools, name, input);
  }
  assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice', 'alice']);
  assert.equal(http.requests.length, 2);
});

test('direct input boundary rejects blank, overlong and invalid limits but accepts bounds', async t => {
  const http = await fixture(); t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  for (const input of [{ query: '' }, { query: '\t\n' }, { query: 'x'.repeat(4097) },
    ...[0, 21, 1.5, '5', null].map(limit => ({ query: 'drink', limit }))]) {
    await assert.rejects(() => execute(tools, 'memory_search', input), { message: 'Memory tool failed.' });
  }
  for (const content of ['', '\t\n', 'x'.repeat(32769)]) {
    await assert.rejects(() => execute(tools, 'memory_ingest', { content }), { message: 'Memory tool failed.' });
  }
  await execute(tools, 'memory_search', { query: 'x'.repeat(4096), limit: 20 });
  await execute(tools, 'memory_ingest', { content: 'x'.repeat(32768) });
  assert.equal(http.requests[0]?.body.limit, 20);
  assert.equal(String(http.requests[1]?.body.conversation).length, 32768);
});

test('AI SDK rejects model bypasses for every tool before HTTP, then executes allowed inputs', async t => {
  const http = await fixture(); t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  const invalid = cases.flatMap(({ name, input }) =>
    ['scope', 'user', 'thread', 'namespace', 'apiKey', 'apiUrl', 'params', 'filter'].map(key => ({
      toolName: name, input: { ...input, [key]: 'other-user-or-secret' },
    })));
  const calls = [...invalid, ...cases.map(({ name, input }) => ({ toolName: name, input }))];
  const result = await generateText({ model: toolModel(calls), tools,
    prompt: 'Use allowed memory arguments', stopWhen: stepCountIs(2) });
  assert.equal(result.text, 'Memory checked.');
  assert.equal(result.steps[0]?.content.filter(part => part.type === 'tool-error').length, 16);
  assert.equal(result.steps[0]?.toolResults.length, 2);
  assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice', 'alice']);
  assert.equal(http.requests.length, 2);
});

for (const status of [401, 422, 429, 500]) {
  test(`HTTP ${status} failures are safe thrown errors and actual AI SDK tool-error parts`, async t => {
    const http = await fixture(async (_request, response) => {
      response.statusCode = status;
      response.end('secret-api-key private body https://private.invalid');
    }); t.after(http.close);
    const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
    const model = toolModel(cases.map(({ name, input }) => ({ toolName: name, input })));
    const result = await generateText({ model, tools,
      prompt: 'Check memory', stopWhen: stepCountIs(2) });
    const errors = result.steps[0]?.content.filter(part => part.type === 'tool-error');
    assert.equal(errors?.length, 2);
    for (const part of errors ?? []) {
      assert.equal(part.error instanceof Error ? part.error.message : part.error, 'Memory tool failed.');
      assert(part.error instanceof Error);
      assert.equal(part.error.cause, undefined);
    }
    assert.equal(result.text, 'Memory checked.');
    const nextPrompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    assert.match(nextPrompt, /Memory tool failed/);
    assert.doesNotMatch(nextPrompt, /secret-api-key|private body|private.invalid/);
    assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice', 'alice']);
  });
}

test('every tool rejects an already-aborted context without exposing its reason', async t => {
  const http = await fixture(); t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  for (const { name, input } of cases) {
    await assert.rejects(() => execute(tools, name, input, AbortSignal.abort('secret-api-key')),
      { name: 'AbortError', message: 'Memory tool aborted.' });
  }
  await execute(tools, 'memory_ingest', { content: 'tea' });
  assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice']);
});

for (const { name, input } of cases) {
  test(`${name} forwards in-flight cancellation to the real SDK transport`, async t => {
    const controller = new AbortController();
    const http = await fixture(async (_request, response) => {
      controller.abort('secret abort reason');
      response.end(JSON.stringify(name === 'memory_search' ? searchBody : ingestBody));
    }); t.after(http.close);
    const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
    await assert.rejects(() => execute(tools, name, input, controller.signal),
      { name: 'AbortError', message: 'Memory tool aborted.' });
    assert.equal(http.requests[0]?.body.user_id, 'alice');
  });
}

test('unexpected pending HTTP 202 ingest fails closed, never empty successful IDs', async t => {
  const http = await fixture(async (_request, response) => {
    response.statusCode = 202; response.end(JSON.stringify({ pending: true }));
  }); t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  await assert.rejects(() => execute(tools, 'memory_ingest', { content: 'tea' }),
    { message: 'Memory tool failed.' });
  assert.equal(http.requests[0]?.body.conversation, 'tea');
});

test('invalid output evidence becomes safe tool errors rather than raw JSON or Zod detail', async t => {
  const http = await fixture(async (request, response) => {
    response.end(JSON.stringify(request.url?.includes('search')
      ? { ...searchBody, retrieval: { ...searchBody.retrieval, embedding_model: { apiKey: 'secret-output' } } }
      : { stored_memory_ids: [{ credentials: 'secret-output' }], updated_memory_ids: [] }));
  }); t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  const model = toolModel(cases.map(({ name, input }) => ({ toolName: name, input })));
  const result = await generateText({ model, tools, prompt: 'Check memory', stopWhen: stepCountIs(2) });
  assert.equal(result.steps[0]?.content.filter(part => part.type === 'tool-error').length, 2);
  assert.match(JSON.stringify(model.doGenerateCalls[1]?.prompt), /Memory tool failed/);
  assert.doesNotMatch(JSON.stringify(model.doGenerateCalls[1]?.prompt), /secret-output|embedding_model|credentials|Zod/);
  assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice', 'alice']);
});

test('transport timeout does not become an empty success or leak the backend URL', async t => {
  const http = await fixture(async (_request, response) => { await once(response, 'close'); }, 20);
  t.after(http.close);
  const tools = memoryTools({ client: http.client, scope: { user: 'alice' } });
  for (const { name, input } of cases) {
    await assert.rejects(() => execute(tools, name, input), { message: 'Memory tool failed.' });
  }
  assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice', 'alice']);
});
