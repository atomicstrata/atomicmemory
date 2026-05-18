/**
 * Phase 1A composition tests.
 *
 * Verifies the runtime container boots cleanly with explicit deps, and
 * that startup checks return a structured result instead of exiting the
 * process. These tests don't depend on a live database — they exercise
 * the composition seam itself.
 */

import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { createCoreRuntime } from '../runtime-container.js';
import { checkEmbeddingDimensions } from '../startup-checks.js';
import { createApp } from '../create-app.js';
import { config, type RuntimeConfig } from '../../config.js';

function stubPool(rows: Array<{ typmod: number }> = []): pg.Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as pg.Pool;
}

function runtimeConfig(overrides: Partial<RuntimeConfig>): RuntimeConfig {
  return { ...config, ...overrides };
}

describe('createCoreRuntime', () => {
  it('composes a runtime with explicit pool dep', async () => {
    const pool = stubPool();
    const runtime = await createCoreRuntime({ pool });
    expect(runtime.pool).toBe(pool);
    expect(runtime.config).toBe(config);
    expect(runtime.repos.memory).toBeDefined();
    expect(runtime.repos.claims).toBeDefined();
    expect(runtime.repos.trust).toBeDefined();
    expect(runtime.repos.links).toBeDefined();
    expect(runtime.services.memory).toBeDefined();
  });

  it('constructs domain-facing stores alongside repos', async () => {
    const pool = stubPool();
    const runtime = await createCoreRuntime({ pool });
    expect(runtime.stores.memory).toBeDefined();
    expect(runtime.stores.episode).toBeDefined();
    expect(runtime.stores.search).toBeDefined();
    expect(runtime.stores.link).toBeDefined();
    expect(runtime.stores.representation).toBeDefined();
    expect(runtime.stores.claim).toBeDefined();
  });

  it('store entity/lesson track config flags', async () => {
    const pool = stubPool();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ entityGraphEnabled: false }) })).stores.entity).toBeNull();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ entityGraphEnabled: true }) })).stores.entity).not.toBeNull();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ lessonsEnabled: false }) })).stores.lesson).toBeNull();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ lessonsEnabled: true }) })).stores.lesson).not.toBeNull();
  });

  it('uses the module-level config singleton by default', async () => {
    const pool = stubPool();
    const runtime = await createCoreRuntime({ pool });
    expect(runtime.config).toBe(config);
  });

  it('accepts an explicit composition-time config for isolated harnesses', async () => {
    const pool = stubPool();
    const cfg = runtimeConfig({
      embeddingProvider: 'voyage',
      embeddingModel: 'unused-for-voyage',
      embeddingDimensions: 1024,
      voyageApiKey: 'test-voyage-key',
      voyageDocumentModel: 'voyage-4-large',
      voyageQueryModel: 'voyage-4-lite',
    });
    const runtime = await createCoreRuntime({ pool, config: cfg });
    expect(runtime.config).toBe(cfg);
    expect(runtime.configRouteAdapter.current().embeddingProvider).toBe('voyage');
    expect(runtime.configRouteAdapter.current().voyageDocumentModel).toBe('voyage-4-large');
  });

  it('entity repo tracks config.entityGraphEnabled', async () => {
    const pool = stubPool();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ entityGraphEnabled: false }) })).repos.entities).toBeNull();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ entityGraphEnabled: true }) })).repos.entities).not.toBeNull();
  });

  it('lesson repo tracks config.lessonsEnabled', async () => {
    const pool = stubPool();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ lessonsEnabled: false }) })).repos.lessons).toBeNull();
    expect((await createCoreRuntime({ pool, config: runtimeConfig({ lessonsEnabled: true }) })).repos.lessons).not.toBeNull();
  });

  it('mutates the runtime-local config through the route adapter', async () => {
    const pool = stubPool();
    const cfg = runtimeConfig({ maxSearchResults: 3 });
    const runtime = await createCoreRuntime({ pool, config: cfg });
    expect(runtime.configRouteAdapter.update({ maxSearchResults: 9 })).toEqual(['maxSearchResults']);
    expect(cfg.maxSearchResults).toBe(9);
    expect(config.maxSearchResults).not.toBe(9);
  });
});

describe('checkEmbeddingDimensions', () => {
  it('returns ok=false when memories.embedding column is missing', async () => {
    const pool = stubPool([]);
    const result = await checkEmbeddingDimensions(pool, config);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('run npm run migrate');
  });

  it('returns ok=false when DB dims differ from config', async () => {
    const pool = stubPool([{ typmod: 1024 }]);
    const cfg = { ...config, embeddingDimensions: 1536 };
    const result = await checkEmbeddingDimensions(pool, cfg);
    expect(result.ok).toBe(false);
    expect(result.dbDims).toBe(1024);
    expect(result.configDims).toBe(1536);
    expect(result.message).toContain('1024 dimensions');
    expect(result.message).toContain('EMBEDDING_DIMENSIONS=1536');
  });

  it('returns ok=true when DB dims match config', async () => {
    const pool = stubPool([{ typmod: 1024 }]);
    const cfg = { ...config, embeddingDimensions: 1024 };
    const result = await checkEmbeddingDimensions(pool, cfg);
    expect(result.ok).toBe(true);
    expect(result.dbDims).toBe(1024);
  });

  it('returns ok=true when DB typmod is unset (0 or negative)', async () => {
    const pool = stubPool([{ typmod: -1 }]);
    const result = await checkEmbeddingDimensions(pool, config);
    expect(result.ok).toBe(true);
    expect(result.dbDims).toBeNull();
  });
});

describe('createApp', () => {
  it('returns an Express app wired from a runtime container', async () => {
    const pool = stubPool();
    const runtime = await createCoreRuntime({ pool });
    const app = createApp(runtime);
    expect(typeof app.use).toBe('function');
    expect(typeof app.listen).toBe('function');
  });
});
