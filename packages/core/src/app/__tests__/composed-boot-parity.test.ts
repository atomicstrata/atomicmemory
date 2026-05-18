/**
 * Phase 1A composed-boot parity test.
 *
 * Boots `createApp(createCoreRuntime({ pool }))` against an ephemeral
 * port and proves that the composed app's HTTP behavior matches a
 * hand-wired singleton-backed reference. This closes the gap left by
 * `runtime-container.test.ts` (composition-shape only, no live HTTP)
 * and `route-validation.test.ts` (route logic, deliberately bypasses
 * the composition seam).
 *
 * The test is narrow by design — Phase 1A is about proving the
 * composition seam doesn't drop fidelity, not about covering every
 * config-threading scenario. That's Phase 1B scope.
 *
 * Acceptance criteria: GET /v1/memories/health, GET /v1/memories/stats,
 * and PUT /v1/memories/config round-trip identically between the composed
 * and reference apps.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { MemoryRepository } from '../../db/memory-repository.js';
import { ClaimRepository } from '../../db/claim-repository.js';
import { MemoryService } from '../../services/memory-service.js';
import { createMemoryRouter } from '../../routes/memories.js';
import { createCoreRuntime } from '../runtime-container.js';
import { createApp } from '../create-app.js';
import { type BootedApp, bindEphemeral } from '../bind-ephemeral.js';
import { authHeader } from '../../__tests__/helpers/auth-headers.js';
import { expectMaxSearchResultsApplied } from '../../__tests__/helpers/config-route-assertions.js';
import { migrate } from '../../db/migration-api.js';

const TEST_USER = 'composed-boot-parity-user';

/**
 * Build the singleton-backed reference app — what server.ts looked like
 * before Phase 1A. Used as the parity baseline.
 */
function buildReferenceApp(): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());
  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  const service = new MemoryService(repo, claimRepo);
  app.use('/v1/memories', createMemoryRouter(service));
  return app;
}

/**
 * Fetch the same path on both the composed and reference apps, assert each
 * is HTTP 200, and return the parsed JSON bodies. Shared by the health and
 * stats parity assertions so the dual-fetch / 200 / parse pattern lives
 * in one place rather than two.
 */
async function fetchBothAndAssertOk(
  composed: BootedApp,
  reference: BootedApp,
  path: string,
): Promise<{ composedBody: unknown; referenceBody: unknown }> {
  const composedRes = await fetch(`${composed.baseUrl}${path}`, { headers: authHeader() });
  const referenceRes = await fetch(`${reference.baseUrl}${path}`, { headers: authHeader() });
  expect(composedRes.status).toBe(200);
  expect(referenceRes.status).toBe(200);
  const composedBody = await composedRes.json();
  const referenceBody = await referenceRes.json();
  return { composedBody, referenceBody };
}

describe('composed boot parity', () => {
  let composed: BootedApp;
  let reference: BootedApp;

  beforeAll(async () => {
    await migrate({ pool });

    composed = await bindEphemeral(createApp(await createCoreRuntime({ pool })));
    reference = await bindEphemeral(buildReferenceApp());
  });

  afterAll(async () => {
    await composed.close();
    await reference.close();
    await pool.end();
  });

  it('GET /v1/memories/health returns the same config payload from both apps', async () => {
    const { composedBody, referenceBody } = await fetchBothAndAssertOk(
      composed,
      reference,
      '/v1/memories/health',
    );
    expect(composedBody).toEqual(referenceBody);
    const health = composedBody as {
      status: string;
      config: { embedding_provider: string; entity_graph_enabled: boolean };
    };
    expect(health.status).toBe('ok');
    expect(health.config.embedding_provider).toBe(config.embeddingProvider);
    expect(health.config.entity_graph_enabled).toBe(config.entityGraphEnabled);
  });

  it('GET /v1/memories/stats traverses routes → services → repos → pool through the composition seam', async () => {
    const { composedBody, referenceBody } = await fetchBothAndAssertOk(
      composed,
      reference,
      `/v1/memories/stats?user_id=${TEST_USER}`,
    );
    // Both queries hit the same DB with no preceding writes — counts
    // must match. If the composed seam silently dropped a layer, this
    // would either 500 or return a different shape.
    expect(composedBody).toEqual(referenceBody);
    const stats = composedBody as { count: number; source_distribution: unknown };
    expect(typeof stats.count).toBe('number');
    expect(stats.source_distribution).toBeDefined();
  });

  // Runs last so any failure of the finally{} cleanup cannot bleed into
  // the GET parity tests above. Cleanup mutates the config singleton
  // directly rather than via a follow-up PUT so it does not depend on
  // either server still being healthy at teardown.
  it('PUT /v1/memories/config mutation is observable via GET /v1/memories/health on both composed and reference apps', async () => {
    const originalMaxResults = config.maxSearchResults;
    const sentinel = originalMaxResults + 17;

    try {
      const putRes = await fetch(`${composed.baseUrl}/v1/memories/config`, {
        method: 'PUT',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_search_results: sentinel }),
      });
      await expectMaxSearchResultsApplied(putRes, sentinel);

      // The mutation goes through the composed app's PUT route into the
      // module-level config singleton. The reference app reads the same
      // singleton, so its /health must reflect the change too — that
      // parity is the proof the composed write seam is honestly wired
      // to the same config the rest of the runtime reads from.
      const { composedBody, referenceBody } = await fetchBothAndAssertOk(
        composed,
        reference,
        '/v1/memories/health',
      );
      const composedHealth = composedBody as { config: { max_search_results: number } };
      const referenceHealth = referenceBody as { config: { max_search_results: number } };
      expect(composedHealth.config.max_search_results).toBe(sentinel);
      expect(referenceHealth.config.max_search_results).toBe(sentinel);
      expect(composedHealth).toEqual(referenceHealth);
    } finally {
      // Restore the singleton directly so a server hiccup cannot leak
      // the sentinel into subsequent test files in the same worker.
      (config as { maxSearchResults: number }).maxSearchResults = originalMaxResults;
    }
  });
});
