/**
 * Integration test for additive canonical memory object writes.
 * Verifies the repository can persist a narrow ingested-fact CMO row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestSchema } from './test-fixtures.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { MemoryRepository } from '../memory-repository.js';
import { pool } from '../pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('canonical memory objects', () => {
  const repo = new MemoryRepository(pool);

  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await repo.deleteAll();
    await pool.query('DELETE FROM canonical_memory_objects');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('stores provenance and temporal anchors for ingested fact objects', async () => {
    const observedAt = new Date('2026-04-07T12:34:56.000Z');
    const cmoId = await repo.storeCanonicalMemoryObject({
      userId: 'cmo-user',
      objectFamily: 'ingested_fact',
      canonicalPayload: {
        factText: 'The user uses Supabase for the dotctl backend.',
        factType: 'project',
        headline: 'Uses Supabase for dotctl',
        keywords: ['Supabase', 'dotctl', 'backend'],
      },
      provenance: {
        episodeId: 'episode-1',
        sourceSite: 'claude.ai',
        sourceUrl: 'https://claude.ai/chat/test',
      },
      observedAt,
      lineage: {
        mutationType: 'add',
        previousObjectId: null,
      },
    });

    const result = await pool.query(
      `SELECT id, user_id, object_family, canonical_payload, provenance, observed_at, lineage
       FROM canonical_memory_objects
       WHERE id = $1`,
      [cmoId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].user_id).toBe('cmo-user');
    expect(result.rows[0].object_family).toBe('ingested_fact');
    expect(result.rows[0].canonical_payload.factText).toContain('Supabase');
    expect(result.rows[0].provenance.sourceSite).toBe('claude.ai');
    expect(new Date(result.rows[0].observed_at).toISOString()).toBe(observedAt.toISOString());
    expect(result.rows[0].lineage.mutationType).toBe('add');
  });
});
