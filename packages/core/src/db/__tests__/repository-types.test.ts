/**
 * Unit tests for repository-types.ts pure functions.
 * Tests data normalization functions that run on every DB read path:
 * importance clamping, embedding parsing, metadata parsing, row normalization.
 */

import { describe, it, expect } from 'vitest';
import {
  clampImportance,
  parseEmbedding,
  parseMetadata,
  parseStringArray,
  normalizeAtomicFactRow,
  normalizeForesightRow,
  normalizeMemoryRow,
  normalizeSearchRow,
  normalizeVersionRow,
} from '../repository-types.js';

describe('clampImportance', () => {
  it('passes through values in [0, 1]', () => {
    expect(clampImportance(0)).toBe(0);
    expect(clampImportance(0.5)).toBe(0.5);
    expect(clampImportance(1)).toBe(1);
  });

  it('clamps values above 1', () => {
    expect(clampImportance(1.5)).toBe(1);
    expect(clampImportance(100)).toBe(1);
  });

  it('clamps values below 0', () => {
    expect(clampImportance(-0.1)).toBe(0);
    expect(clampImportance(-100)).toBe(0);
  });
});

describe('parseEmbedding', () => {
  it('returns array values as numbers', () => {
    expect(parseEmbedding([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });

  it('converts string array elements to numbers', () => {
    expect(parseEmbedding(['0.1', '0.2'])).toEqual([0.1, 0.2]);
  });

  it('parses pgvector string format "[0.1,0.2,0.3]"', () => {
    expect(parseEmbedding('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
  });

  it('handles empty pgvector string "[]"', () => {
    expect(parseEmbedding('[]')).toEqual([]);
  });

  it('returns empty array for null/undefined', () => {
    expect(parseEmbedding(null)).toEqual([]);
    expect(parseEmbedding(undefined)).toEqual([]);
  });

  it('returns empty array for non-string non-array', () => {
    expect(parseEmbedding(42)).toEqual([]);
    expect(parseEmbedding({})).toEqual([]);
  });

  it('handles negative values in pgvector string', () => {
    expect(parseEmbedding('[-0.5,0.3,-0.1]')).toEqual([-0.5, 0.3, -0.1]);
  });
});

describe('parseMetadata', () => {
  it('returns the object as MemoryMetadata', () => {
    const meta = { clarification_note: 'test', custom: 123 };
    expect(parseMetadata(meta)).toEqual(meta);
  });

  it('returns empty object for null', () => {
    expect(parseMetadata(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(parseMetadata(undefined)).toEqual({});
  });

  it('returns empty object for non-object values', () => {
    expect(parseMetadata('string')).toEqual({});
    expect(parseMetadata(42)).toEqual({});
    expect(parseMetadata(true)).toEqual({});
  });

  it('returns empty object for arrays', () => {
    expect(parseMetadata([1, 2, 3])).toEqual({});
  });
});

describe('parseStringArray', () => {
  it('passes through string arrays', () => {
    expect(parseStringArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('parses postgres array strings', () => {
    expect(parseStringArray('{a,b,c}')).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for non-arrays', () => {
    expect(parseStringArray(null)).toEqual([]);
  });
});

describe('normalizeMemoryRow', () => {
  const RAW_ROW = {
    id: 'mem-1',
    user_id: 'user-1',
    content: 'Test memory',
    embedding: '[0.1,0.2,0.3]',
    memory_type: 'preference',
    importance: 0.7,
    source_site: 'chatgpt.com',
    source_url: '',
    episode_id: null,
    status: 'active',
    metadata: { clarification_note: 'note' },
    keywords: 'test',
    namespace: null,
    summary: '',
    overview: '',
    trust_score: 1.0,
    created_at: new Date('2026-01-01'),
    last_accessed_at: new Date('2026-01-02'),
    access_count: 3,
    deleted_at: null,
  };

  it('parses embedding from pgvector string', () => {
    const row = normalizeMemoryRow(RAW_ROW);
    expect(row.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('preserves metadata object', () => {
    const row = normalizeMemoryRow(RAW_ROW);
    expect(row.metadata.clarification_note).toBe('note');
  });

  it('normalizes null metadata', () => {
    const row = normalizeMemoryRow({ ...RAW_ROW, metadata: null });
    expect(row.metadata).toEqual({});
  });

  it('preserves all other fields unchanged', () => {
    const row = normalizeMemoryRow(RAW_ROW);
    expect(row.id).toBe('mem-1');
    expect(row.content).toBe('Test memory');
    expect(row.importance).toBe(0.7);
    expect(row.namespace).toBeNull();
  });
});

describe('normalizeSearchRow', () => {
  it('normalizes embedding and metadata like normalizeMemoryRow', () => {
    const raw = {
      id: 'mem-1',
      user_id: 'user-1',
      content: 'Test',
      embedding: '[0.5,0.6]',
      memory_type: 'knowledge',
      importance: 0.8,
      source_site: 'claude.ai',
      source_url: '',
      episode_id: null,
      status: 'active',
      metadata: null,
      keywords: '',
      namespace: null,
      summary: '',
      overview: '',
      trust_score: 1.0,
      created_at: new Date(),
      last_accessed_at: new Date(),
      access_count: 0,
      deleted_at: null,
      similarity: 0.92,
      score: 0.85,
      matched_facts: '{fact one,fact two}',
      matched_fact_ids: ['f1', 'f2'],
      retrieval_layer: 'atomic_fact',
    };
    const row = normalizeSearchRow(raw);
    expect(row.embedding).toEqual([0.5, 0.6]);
    expect(row.metadata).toEqual({});
    expect(row.similarity).toBe(0.92);
    expect(row.score).toBe(0.85);
    expect(row.matched_facts).toEqual(['fact one', 'fact two']);
    expect(row.matched_fact_ids).toEqual(['f1', 'f2']);
    expect(row.retrieval_layer).toBe('atomic_fact');
  });
});

describe('child representation normalizers', () => {
  it('normalizes atomic fact rows', () => {
    const row = normalizeAtomicFactRow({
      id: 'fact-1',
      user_id: 'user-1',
      parent_memory_id: 'mem-1',
      fact_text: 'User uses Supabase',
      embedding: '[0.1,0.2]',
      fact_type: 'project',
      importance: 0.8,
      source_site: 'test',
      source_url: '',
      episode_id: null,
      keywords: 'Supabase',
      metadata: { headline: 'Uses Supabase' },
      created_at: new Date(),
    });
    expect(row.embedding).toEqual([0.1, 0.2]);
    expect(row.metadata.headline).toBe('Uses Supabase');
  });

  it('normalizes foresight rows', () => {
    const row = normalizeForesightRow({
      id: 'fs-1',
      user_id: 'user-1',
      parent_memory_id: 'mem-1',
      content: 'User plans to ship next week',
      embedding: '[0.3,0.4]',
      foresight_type: 'plan',
      source_site: 'test',
      source_url: '',
      episode_id: null,
      metadata: null,
      valid_from: new Date(),
      valid_to: null,
      created_at: new Date(),
    });
    expect(row.embedding).toEqual([0.3, 0.4]);
    expect(row.metadata).toEqual({});
  });
});

describe('normalizeVersionRow', () => {
  it('parses embedding from pgvector string', () => {
    const raw = {
      id: 'ver-1',
      claim_id: 'claim-1',
      user_id: 'user-1',
      memory_id: 'mem-1',
      content: 'Version content',
      embedding: '[0.7,0.8]',
      importance: 0.6,
      source_site: 'test',
      source_url: '',
      episode_id: null,
      valid_from: new Date(),
      valid_to: null,
      superseded_by_version_id: null,
      created_at: new Date(),
    };
    const row = normalizeVersionRow(raw);
    expect(row.embedding).toEqual([0.7, 0.8]);
    expect(row.content).toBe('Version content');
  });
});
