/**
 * @file Replay tests for `toMemory` against captured `list.raw.json`.
 *
 * Two halves:
 *   - **Equality:** raw → mapper → JSON-roundtrip (so Date↔ISO
 *     mismatches don't fail) → deep-equal against the captured
 *     `list.mapped.json`. Detects future drift.
 *   - **Semantic contract:** asserts the specific fields consumers
 *     depend on actually surface where they belong. Detects the
 *     *current* class of contract bug — the kind PR #25 / #27
 *     fixed at the consumer boundary, now also locked in at the
 *     SDK boundary.
 *
 * Driven by `list.raw.json` only, NOT search responses. List rows
 * carry the richest wire shape (full memory rows including
 * `source_url`, `episode_id`, `observed_at`, etc.); search
 * responses do NOT carry `source_url` / `episode_id` per
 * `atomicmemory-core/src/routes/memories.ts:744`. Applying
 * `toMemory` to search rows here would over-assert. Search-derived
 * `Memory` instances are tested in
 * `to-search-result.fixtures.test.ts` with a narrower contract.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { toMemory } from '../mappers';
import type { Scope } from '../../types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

interface RawMemoryRow {
  id: string;
  content: string;
  source_site?: string;
  source_url?: string;
  episode_id?: string;
  importance?: number;
  created_at?: string;
  [key: string]: unknown;
}

interface ListResponse {
  memories: RawMemoryRow[];
  count: number;
}

const SCOPE: Scope = { user: 'fixture-capture' };

const listRaw = JSON.parse(
  readFileSync(join(FIXTURES, 'list.raw.json'), 'utf-8'),
) as ListResponse;

const listMapped = JSON.parse(
  readFileSync(join(FIXTURES, 'list.mapped.json'), 'utf-8'),
) as unknown[];

describe('toMemory — fixture replay (list)', () => {
  it('list.raw.json maps to list.mapped.json (equality)', () => {
    const mapped = listRaw.memories.map((row) =>
      JSON.parse(JSON.stringify(toMemory(row, SCOPE))),
    );
    expect(mapped).toEqual(listMapped);
  });
});

describe('toMemory — semantic contract (list)', () => {
  const mapped = listRaw.memories.map((row) => toMemory(row, SCOPE));

  it('at least one mapped Memory has provenance.source equal to a captured source_site', () => {
    const captured = new Set(
      listRaw.memories.map((m) => m.source_site).filter((s): s is string => !!s),
    );
    expect(captured.size).toBeGreaterThan(0);
    const surfaced = mapped
      .map((m) => m.provenance?.source)
      .filter((s): s is string => typeof s === 'string');
    expect(surfaced.some((s) => captured.has(s))).toBe(true);
  });

  it('at least one mapped Memory has provenance.sourceUrl equal to a captured source_url', () => {
    const captured = new Set(
      listRaw.memories.map((m) => m.source_url).filter((s): s is string => !!s),
    );
    expect(captured.size).toBeGreaterThan(0);
    const surfaced = mapped
      .map((m) => m.provenance?.sourceUrl)
      .filter((s): s is string => typeof s === 'string');
    expect(surfaced.some((s) => captured.has(s))).toBe(true);
  });

  it('at least one mapped Memory has metadata.episodeId equal to a captured episode_id', () => {
    const captured = new Set(
      listRaw.memories.map((m) => m.episode_id).filter((s): s is string => !!s),
    );
    expect(captured.size).toBeGreaterThan(0);
    const surfaced = mapped
      .map((m) => m.metadata?.episodeId)
      .filter((s): s is string => typeof s === 'string');
    expect(surfaced.some((s) => captured.has(s))).toBe(true);
  });

  it('at least one mapped Memory has metadata.importance preserved', () => {
    const haveImportance = listRaw.memories.filter((m) => m.importance !== undefined);
    expect(haveImportance.length).toBeGreaterThan(0);
    const surfaced = mapped
      .map((m) => m.metadata?.importance)
      .filter((v): v is number => typeof v === 'number');
    expect(surfaced.length).toBeGreaterThan(0);
  });

  it('at least one mapped Memory has BOTH metadata.importance AND metadata.episodeId set together', () => {
    // Guards against a regression where one mapping wins by replacing
    // the metadata object instead of merging into it.
    const both = mapped.filter(
      (m) =>
        typeof m.metadata?.importance === 'number' &&
        typeof m.metadata?.episodeId === 'string',
    );
    expect(both.length).toBeGreaterThan(0);
  });

  it('every record: raw created_at → Memory.createdAt is a Date with matching ISO', () => {
    for (const row of listRaw.memories) {
      if (!row.created_at) continue;
      const m = toMemory(row, SCOPE);
      expect(m.createdAt).toBeInstanceOf(Date);
      expect(m.createdAt.toISOString()).toBe(row.created_at);
    }
  });
});
