/** Assert the locally linked example's observable results across independent conversations. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOfflineDemo } from './demo.js';

test('memory tools persist synthetic fixture data across conversations and isolate subjects', async () => {
  assert.deepEqual(await runOfflineDemo(), {
    backend: 'local-contract-fixture',
    model: 'deterministic-ai-sdk-test-model',
    createdIds: ['fixture-fact-1'],
    updatedIds: ['fixture-fact-1'],
    firstRecall: 'I prefer tea.',
    laterRecall: 'I now prefer coffee.',
    otherUserRecall: 'No memories found.',
    retrievalTraceId: 'fixture-search-trace',
    hostedCloudVerified: false,
    engineCorrectionVerified: false,
  });
});
