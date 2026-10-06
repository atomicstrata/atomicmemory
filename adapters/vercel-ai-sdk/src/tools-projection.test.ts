/** Pure output policy tests for count/content bounds and evidence retention. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSearch } from './tools-projection.js';
import { makeMemory } from './test-fixtures.js';

test('caps every hit and aggregate content with truthful markers, retaining hit IDs', () => {
  const results = Array.from({ length: 7 }, (_, i) => ({ ...makeMemory('x'.repeat(5000)),
    memory: { ...makeMemory('x').memory, id: `id-${i}`, content: 'x'.repeat(5000),
      metadata: { credential: 'secret' }, provenance: { sourceUrl: 'private' } } }));
  const output = projectSearch({ results }, 6);
  assert.deepEqual(output.results.map(hit => [hit.id, hit.content.length, hit.truncated]), [
    ['id-0', 4096, true], ['id-1', 4096, true], ['id-2', 4096, true],
    ['id-3', 4096, true], ['id-4', 0, true], ['id-5', 0, true],
  ]);
  assert.equal(output.truncated, true);
  assert.equal(output.results.map(hit => hit.content).join(''), 'x'.repeat(16384));
  assert.doesNotMatch(JSON.stringify(output), /credential|secret|private|scope|provenance/);
});

test('no truncation at exact bounds; real cursor retained and omitted receipt stays absent', () => {
  const output = projectSearch({ results: [makeMemory('x'.repeat(4096))], cursor: 'next-page' }, 1);
  assert.deepEqual(output, { results: [{ id: 'mem-xxxxxxxx', content: 'x'.repeat(4096),
    score: 0.9, truncated: false }], truncated: false, cursor: 'next-page' });
});

test('surrogate-safe cuts obey hit and remaining aggregate budgets', () => {
  const output = projectSearch({ results: [
    makeMemory('x'.repeat(4095) + '🙂more'),
    ...Array.from({ length: 3 }, () => makeMemory('x'.repeat(4096))),
    makeMemory('🙂more'),
  ] }, 5);
  assert.deepEqual(output.results.map(hit => [hit.content.length, hit.truncated]), [
    [4095, true], [4096, false], [4096, false], [4096, false], [0, true],
  ]);
  assert.equal(output.results[0]?.content, 'x'.repeat(4095));
  assert.equal(output.results[4]?.content, '');
  assert.equal(output.truncated, true);
});

test('backend over-return leaves the receipt candidate order unchanged and strips private fields', () => {
  const retrieval = { embeddingProvider: 'fixture', embeddingModel: 'model', embeddingModelVersion: 'v1',
    embeddingDimensions: 3, queryText: 'tea', candidateIds: ['one', 'two', 'three'], traceId: 'trace',
    apiKey: 'secret-receipt', metadata: { secret: 'secret-metadata' }, scope: { user: 'secret-user' } };
  const output = projectSearch({ results: [makeMemory('one'), makeMemory('two')], retrieval,
    cursor: 'next', extra: 'secret-page' }, 1);
  assert.deepEqual(output, { results: [{ id: 'mem-one', content: 'one', score: 0.9, truncated: false }],
    truncated: true, cursor: 'next', retrieval: { embeddingProvider: 'fixture', embeddingModel: 'model',
      embeddingModelVersion: 'v1', embeddingDimensions: 3, queryText: 'tea',
      candidateIds: ['one', 'two', 'three'], traceId: 'trace' } });
  assert.deepEqual(retrieval.candidateIds, ['one', 'two', 'three']);
  assert.doesNotMatch(JSON.stringify(output), /secret-/);
});

test('invalid allowlisted results and receipts cannot be delivered as successes', () => {
  for (const hit of [
    { ...makeMemory('tea'), score: Infinity },
    { ...makeMemory('tea'), similarity: 'secret' },
    { ...makeMemory('tea'), versionId: { secret: 'value' } },
    { ...makeMemory('tea'), observedAt: [] },
    { ...makeMemory('tea'), memory: { id: 'tea', content: { secret: 'value' } } },
  ]) assert.throws(() => projectSearch({ results: [hit] }, 1));
  const receipt = { embeddingModel: 'model', embeddingModelVersion: 'v1', embeddingDimensions: 3,
    queryText: 'tea', candidateIds: ['tea'], traceId: 'trace' };
  for (const [key, value] of [
    ['embeddingProvider', {}], ['embeddingModel', []], ['embeddingModelVersion', null],
    ['embeddingDimensions', -1], ['queryText', {}], ['candidateIds', [{ secret: 'value' }]],
    ['traceId', 1],
  ]) assert.throws(() => projectSearch({ results: [], retrieval: { ...receipt, [String(key)]: value } }, 1));
  assert.deepEqual(projectSearch({ results: [makeMemory('tea')] }, 1), {
    results: [{ id: 'mem-tea', content: 'tea', score: 0.9, truncated: false }], truncated: false,
  });
});
