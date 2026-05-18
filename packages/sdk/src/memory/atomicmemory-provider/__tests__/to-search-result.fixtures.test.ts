/**
 * @file Replay tests for `toSearchResult` against captured search
 * + search/fast fixtures.
 *
 * Semantic-contract assertions are scoped to fields core's search
 * formatter actually emits — `id`, `content`, `similarity`,
 * `score`, `importance`, `source_site`, `created_at` — see
 * `atomicmemory-core/src/routes/memories.ts:744`. `source_url` and
 * `episode_id` surfacing is asserted on the LIST fixture
 * (`to-memory.fixtures.test.ts`), where the wire shape carries
 * them. Asserting them here would either be vacuous (no raw value
 * to surface) or require a separate change to core's search
 * formatter — out of scope for this PR.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { toSearchResult } from '../mappers';
import type { Scope } from '../../types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

interface RawSearchMemory {
  id: string;
  content: string;
  similarity?: number;
  semantic_similarity?: number;
  score?: number;
  ranking_score?: number;
  relevance?: number;
  importance?: number;
  source_site?: string;
  created_at?: string;
  [key: string]: unknown;
}

interface RawSearchResponse {
  memories: RawSearchMemory[];
  [key: string]: unknown;
}

const SCOPE: Scope = { user: 'fixture-capture' };

const fixtures: Array<{ label: string; raw: string; mapped: string }> = [
  { label: 'search', raw: 'search.raw.json', mapped: 'search.mapped.json' },
  { label: 'search-fast', raw: 'search-fast.raw.json', mapped: 'search-fast.mapped.json' },
];

describe.each(fixtures)('toSearchResult — fixture replay ($label)', ({ raw, mapped }) => {
  const rawResponse = JSON.parse(
    readFileSync(join(FIXTURES, raw), 'utf-8'),
  ) as RawSearchResponse;
  const expected = JSON.parse(
    readFileSync(join(FIXTURES, mapped), 'utf-8'),
  ) as unknown[];

  it('memories[] maps to expected mapped fixture (equality)', () => {
    const actual = rawResponse.memories.map((row) =>
      JSON.parse(JSON.stringify(toSearchResult(row, SCOPE))),
    );
    expect(actual).toEqual(expected);
  });

  it('semantic contract: every result.score is a finite number', () => {
    for (const row of rawResponse.memories) {
      const result = toSearchResult(row, SCOPE);
      expect(typeof result.score).toBe('number');
      expect(Number.isFinite(result.score)).toBe(true);
    }
  });

  it('semantic contract: explicit score semantics are exposed when core emits them', () => {
    for (const row of rawResponse.memories) {
      const result = toSearchResult(row, SCOPE);
      expect(result.similarity).toBe(row.semantic_similarity ?? row.similarity);
      expect(result.rankingScore).toBe(row.ranking_score ?? row.score);
      expect(result.relevance).toBe(row.relevance);
    }
  });

  it('semantic contract: result.memory.id and .content are set', () => {
    for (const row of rawResponse.memories) {
      const result = toSearchResult(row, SCOPE);
      expect(result.memory.id).toBe(row.id);
      expect(result.memory.content).toBe(row.content);
    }
  });

  it('semantic contract: raw source_site → result.memory.provenance.source', () => {
    for (const row of rawResponse.memories) {
      if (row.source_site === undefined) continue;
      const result = toSearchResult(row, SCOPE);
      expect(result.memory.provenance?.source).toBe(row.source_site);
    }
  });

  it('semantic contract: raw created_at → result.memory.createdAt with matching ISO', () => {
    for (const row of rawResponse.memories) {
      if (!row.created_at) continue;
      const result = toSearchResult(row, SCOPE);
      expect(result.memory.createdAt).toBeInstanceOf(Date);
      expect(result.memory.createdAt.toISOString()).toBe(row.created_at);
    }
  });
});
