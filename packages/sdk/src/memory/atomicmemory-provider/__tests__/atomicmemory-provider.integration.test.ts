/**
 * Live-core integration test for AtomicMemoryProvider.
 *
 * Opt-in: runs only when `ATOMICMEMORY_TEST_API_URL` points at a running
 * atomicmemory-core (set `ATOMICMEMORY_TEST_API_KEY` too if the core requires
 * auth). Skipped otherwise, so the default unit suite stays hermetic.
 *
 *   ATOMICMEMORY_TEST_API_URL=http://localhost:17350 \
 *   ATOMICMEMORY_TEST_API_KEY=local-dev-key \
 *     npx vitest run src/memory/atomicmemory-provider/__tests__/atomicmemory-provider.integration.test.ts
 *
 * Verifies the SDK <-> core wire contract end to end against a real backend —
 * specifically that the audit-grade retrieval receipt and per-result
 * version/observed fields the SDK now surfaces (PR #19) are actually emitted by
 * core and mapped through, and that verbatim ingest keyed by `externalId` is
 * idempotent (no duplicate on re-ingest).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { AtomicMemoryProvider } from '../atomicmemory-provider';

const apiUrl = process.env.ATOMICMEMORY_TEST_API_URL;
const runLive = apiUrl ? describe : describe.skip;

runLive('AtomicMemoryProvider live integration', () => {
  // Constructed in beforeAll, not at collection time: the describe body still
  // runs when the suite is skipped, and `new AtomicMemoryProvider({apiUrl:
  // undefined})` would throw.
  let provider: AtomicMemoryProvider;
  const scope = { user: 'sdk-itest-user' };
  const externalId = 'sdk-itest-receipt';
  const content =
    'Integration probe: Northstar Atlas deploys on-prem and prioritizes low query latency.';

  beforeAll(async () => {
    provider = new AtomicMemoryProvider({
      apiUrl: apiUrl as string,
      apiKey: process.env.ATOMICMEMORY_TEST_API_KEY,
    });
    await provider.initialize?.();
    await provider.ingest({
      mode: 'verbatim',
      scope,
      content,
      contentClass: 'summary',
      metadata: { externalId },
    });
  });

  it('search surfaces the audit-grade retrieval receipt from a live core', async () => {
    const page = await provider.search({ query: 'on-prem low latency Atlas', scope, limit: 5 });

    expect(page.results.length).toBeGreaterThan(0);
    expect(page.retrieval).toBeDefined();
    expect(page.retrieval?.embeddingModel).toBeTruthy();
    expect(page.retrieval?.embeddingModelVersion).toBeTruthy();
    expect(Array.isArray(page.retrieval?.candidateIds)).toBe(true);
    expect(page.retrieval?.traceId).toBeTruthy();
  });

  it('search hits carry the per-result observed/version receipt fields', async () => {
    const page = await provider.search({ query: 'on-prem low latency Atlas', scope, limit: 5 });
    const hit = page.results[0];

    expect(hit.observedAt).toBeTruthy();
    // versionId is present on the hit (string for a versioned row, null otherwise).
    expect('versionId' in hit).toBe(true);
  });

  it('verbatim ingest keyed by externalId is idempotent on a live core', async () => {
    const before = await provider.search({ query: 'on-prem low latency Atlas', scope, limit: 20 });
    const matches = (page: { results: { memory: { content: string } }[] }) =>
      page.results.filter((r) => r.memory.content === content).length;

    await provider.ingest({
      mode: 'verbatim',
      scope,
      content,
      contentClass: 'summary',
      metadata: { externalId },
    });

    const after = await provider.search({ query: 'on-prem low latency Atlas', scope, limit: 20 });
    // Re-ingesting the same externalId must not create a duplicate live row.
    expect(matches(after)).toBe(matches(before));
    expect(matches(after)).toBe(1);
  });
});
