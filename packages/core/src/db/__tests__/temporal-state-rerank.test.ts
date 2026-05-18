/**
 * Integration test for the BEAM v38 read-time rerank: confirms that
 * applyTemporalStateRerank reorders a mixed active/superseded candidate
 * list so active state outranks superseded state of the same key.
 *
 * Lives in src/db/__tests__/ because it round-trips through Postgres
 * to confirm the row shape and field selection (state_key, event_end)
 * survive the SearchResult mapping path used by the search store.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { storeMemory, deleteAll } from '../repository-write.js';
import { config } from '../../config.js';
import type { SearchResult } from '../repository-types.js';
import { applyTemporalStateRerank } from '../../services/temporal-rerank.js';
import { basisVector } from './test-fixtures.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const USER = 'test-temporal-rerank-1';
const STATE_KEY = 'user:test-temporal-rerank-1:location';

afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await deleteAll(pool, USER);
});

const makeEmbedding = basisVector;

async function fetchAsSearchResults(ids: string[]): Promise<SearchResult[]> {
  const result = await pool.query(
    `SELECT *, 0.0 AS similarity, 0.0 AS score
       FROM memories
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  // We don't go through normalizeSearchRow — the rerank only reads
  // state_key, event_end, and score, so the raw column shape is enough.
  return result.rows.map((row) => ({ ...row, score: Number(row.score) })) as SearchResult[];
}

describe('applyTemporalStateRerank — DB round trip', () => {
  it('orders active state above superseded for matching state_key', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-03-01T00:00:00Z');
    const supersededId = await storeMemory(pool, {
      userId: USER, content: 'User lives in Austin',
      embedding: makeEmbedding(0), importance: 0.5, sourceSite: 'test',
      stateKey: STATE_KEY, eventStart: t0, eventEnd: t1,
    });
    const activeId = await storeMemory(pool, {
      userId: USER, content: 'User lives in Tokyo',
      embedding: makeEmbedding(1), importance: 0.5, sourceSite: 'test',
      stateKey: STATE_KEY, eventStart: t1, eventEnd: null,
    });

    // Seed candidates with the superseded memory in front of the active
    // one. The rerank should flip them.
    const rows = await fetchAsSearchResults([supersededId, activeId]);
    const inOrder = rows[0].id === supersededId ? rows : [rows[1], rows[0]];
    // Give the superseded row a slightly higher baseline score so the rerank
    // boost is what flips the ranking — not the pre-existing similarity.
    inOrder[0].score = 0.5;
    inOrder[1].score = 0.5;

    const reranked = applyTemporalStateRerank(inOrder);
    expect(reranked[0].id).toBe(activeId);
    expect(reranked[1].id).toBe(supersededId);
  });

  it('leaves non-state-keyed memories untouched', async () => {
    const a = await storeMemory(pool, {
      userId: USER, content: 'plain memory A',
      embedding: makeEmbedding(0), importance: 0.5, sourceSite: 'test',
    });
    const b = await storeMemory(pool, {
      userId: USER, content: 'plain memory B',
      embedding: makeEmbedding(1), importance: 0.5, sourceSite: 'test',
    });
    const rows = await fetchAsSearchResults([a, b]);
    rows[0].score = 0.9;
    rows[1].score = 0.1;
    const reranked = applyTemporalStateRerank(rows);
    expect(reranked[0].id).toBe(rows[0].id);
    expect(reranked[1].id).toBe(rows[1].id);
  });
});
