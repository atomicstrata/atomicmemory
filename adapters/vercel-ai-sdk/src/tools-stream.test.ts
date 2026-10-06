/** Real streamed tool failures and UI serialization must not disclose SDK errors. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { memoryTools } from './tools.js';
import { fixture, modelResult } from './tools-test-support.js';

function streamingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doStream: async () => ({
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'tool-call', toolCallId: 'search', toolName: 'memory_search',
        input: JSON.stringify({ query: 'drink' }) });
      controller.enqueue({ type: 'tool-call', toolCallId: 'ingest', toolName: 'memory_ingest',
        input: JSON.stringify({ content: 'tea' }) });
      const finish = modelResult([], true);
      controller.enqueue({ type: 'finish', usage: finish.usage, finishReason: finish.finishReason });
      controller.close();
    } }),
  }) });
}

test('streamText emits both actual tool errors and safe UI error text', async t => {
  const http = await fixture(async (_request, response) => {
    response.statusCode = 500; response.end('secret-api-key private-backend-body');
  }); t.after(http.close);
  const result = streamText({ model: streamingModel(), prompt: 'Check memory',
    tools: memoryTools({ client: http.client, scope: { user: 'alice' } }) });
  const ui = result.toUIMessageStreamResponse({ onError: error => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Memory tool failed.');
    assert.equal(error.cause, undefined);
    return error.message;
  } }).text();
  const errors: string[] = [];
  for await (const part of result.fullStream) {
    if (part.type !== 'tool-error') continue;
    assert(part.error instanceof Error);
    assert.equal(part.error.cause, undefined);
    errors.push(part.error.message);
  }
  assert.deepEqual(errors, ['Memory tool failed.', 'Memory tool failed.']);
  const serialized = await ui;
  assert.match(serialized, /tool-output-error/);
  assert.match(serialized, /Memory tool failed/);
  assert.doesNotMatch(serialized, /secret-api-key|private-backend-body|127\.0\.0\.1/);
  assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice', 'alice']);
});
