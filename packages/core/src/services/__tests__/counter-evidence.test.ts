/**
 * Unit tests for counter-evidence expansion (Sprint 3 v1.1).
 *
 * Mocked pg.Pool — verifies the SQL-query argument shape and the
 * dedup/tag behavior. Integration test against a real Postgres lives
 * under db/__tests__ (not added here to keep the test under the 400-line cap).
 */

import { describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../../db/repository-types.js';
import { expandWithCounterEvidence } from '../counter-evidence.js';

function makeResult(id: string, content: string): SearchResult {
  return {
    id,
    content,
    importance: 0.5,
    similarity: 0.5,
    score: 0.5,
    metadata: {},
    source_site: 'test',
    source_url: '',
  } as unknown as SearchResult;
}

function makePool(rows: Array<{ source_id: string; target_id: string }>, memoryRows: any[] = []) {
  let callCount = 0;
  const pool = {
    query: vi.fn(async (sql: string, _params: unknown[]) => {
      callCount++;
      if (callCount === 1) return { rows };
      return { rows: memoryRows };
    }),
  } as unknown as Parameters<typeof expandWithCounterEvidence>[0]['pool'];
  return { pool, query: (pool as any).query as ReturnType<typeof vi.fn> };
}

const A = makeResult('a', 'fact about Flask sessions');
const B = makeResult('b', 'fact about deployment');

describe('expandWithCounterEvidence', () => {
  it('returns input unchanged when there are no candidates', async () => {
    const { pool, query } = makePool([]);
    const out = await expandWithCounterEvidence({ pool }, 'user1', []);
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns input unchanged when no counter edges exist', async () => {
    const { pool } = makePool([]);
    const out = await expandWithCounterEvidence({ pool }, 'user1', [A, B]);
    expect(out).toEqual([A, B]);
  });

  it('appends counter-source memories and tags metadata', async () => {
    const counterRows = [{ source_id: 'c', target_id: 'a' }];
    const counterMems = [{ id: 'c', content: 'never integrated Flask sessions', metadata: {} }];
    const { pool } = makePool(counterRows, counterMems);
    const out = await expandWithCounterEvidence({ pool }, 'user1', [A, B]);
    expect(out.length).toBe(3);
    expect(out[0]!.id).toBe('a');
    expect(out[1]!.id).toBe('b');
    expect(out[2]!.id).toBe('c');
    const meta = (out[2]! as SearchResult).metadata as Record<string, unknown>;
    expect(meta.counter_evidence_source).toBe(true);
    expect(meta.counter_evidence_for).toEqual(['a']);
  });

  it('does not re-fetch counter-source memories that are already in the candidate set', async () => {
    // counter source 'b' is already in candidates → skip the fetch
    const counterRows = [{ source_id: 'b', target_id: 'a' }];
    const { pool, query } = makePool(counterRows);
    const out = await expandWithCounterEvidence({ pool }, 'user1', [A, B]);
    // Only the belief_edges query, no fetch (b already in candidates)
    expect(query).toHaveBeenCalledOnce();
    expect(out).toEqual([A, B]);
  });

  it('deduplicates counter-source memories pointing at multiple targets', async () => {
    const counterRows = [
      { source_id: 'c', target_id: 'a' },
      { source_id: 'c', target_id: 'b' }, // same source, two targets
    ];
    const counterMems = [{ id: 'c', content: 'counter both', metadata: {} }];
    const { pool } = makePool(counterRows, counterMems);
    const out = await expandWithCounterEvidence({ pool }, 'user1', [A, B]);
    expect(out.length).toBe(3);
    expect(out[2]!.id).toBe('c');
    const meta = (out[2]! as SearchResult).metadata as Record<string, unknown>;
    expect((meta.counter_evidence_for as string[]).sort()).toEqual(['a', 'b']);
  });

  it('passes the candidate IDs as a uuid[] param to the belief_edges query', async () => {
    const { pool, query } = makePool([]);
    await expandWithCounterEvidence({ pool }, 'user1', [A, B]);
    expect(query).toHaveBeenCalledOnce();
    const args = query.mock.calls[0]!;
    const params = args[1] as unknown[];
    expect(params[0]).toBe('user1');
    expect(params[1]).toEqual(['a', 'b']);
  });
});
