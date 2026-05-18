/**
 * @file Hand-written edge-case tests for `toMemory`'s metadata merge.
 *
 * The fixture-driven tests cover the common case (importance > 0
 * AND episodeId set together). Real captures can't reliably force
 * core's ingest pipeline to emit `importance: 0`, so this file
 * covers the falsy-vs-undefined boundary explicitly with synthetic
 * `RawMemory` inputs:
 *
 * - `importance: 0` survives through the mapper (NOT dropped by a
 *   truthiness check)
 * - `importance: 0` and `episode_id` coexist under metadata (the
 *   merge doesn't replace one with the other)
 * - All-undefined optional inputs produce `provenance: undefined`
 *   and `metadata: undefined` (no empty-object emission)
 */

import { describe, it, expect } from 'vitest';
import { toMemory } from '../mappers';
import type { Scope } from '../../types';

const SCOPE: Scope = { user: 'metadata-merge-test' };

describe('toMemory — metadata merge edge cases', () => {
  it('preserves importance: 0 (no truthiness drop)', () => {
    const m = toMemory(
      { id: 'm1', content: 'c', importance: 0 },
      SCOPE,
    );
    expect(m.metadata?.importance).toBe(0);
  });

  it('preserves importance: 0 alongside episodeId', () => {
    const m = toMemory(
      { id: 'm1', content: 'c', importance: 0, episode_id: 'ep-x' },
      SCOPE,
    );
    expect(m.metadata?.importance).toBe(0);
    expect(m.metadata?.episodeId).toBe('ep-x');
  });

  it('emits metadata.episodeId when episode_id is set', () => {
    const m = toMemory(
      { id: 'm1', content: 'c', episode_id: 'ep-x' },
      SCOPE,
    );
    expect(m.metadata?.episodeId).toBe('ep-x');
  });

  it('emits provenance.sourceUrl when source_url is set', () => {
    const m = toMemory(
      { id: 'm1', content: 'c', source_url: 'https://example.com/doc' },
      SCOPE,
    );
    expect(m.provenance?.sourceUrl).toBe('https://example.com/doc');
  });

  it('emits provenance.source AND sourceUrl together', () => {
    const m = toMemory(
      {
        id: 'm1',
        content: 'c',
        source_site: 'webapp-text',
        source_url: 'https://example.com/doc',
      },
      SCOPE,
    );
    expect(m.provenance?.source).toBe('webapp-text');
    expect(m.provenance?.sourceUrl).toBe('https://example.com/doc');
  });

  it('returns provenance undefined when neither source_site nor source_url is set', () => {
    const m = toMemory({ id: 'm1', content: 'c' }, SCOPE);
    expect(m.provenance).toBeUndefined();
  });

  it('returns metadata undefined when neither importance nor episode_id is set', () => {
    const m = toMemory({ id: 'm1', content: 'c' }, SCOPE);
    expect(m.metadata).toBeUndefined();
  });

  it('passes empty-string episode_id through verbatim (current behavior)', () => {
    // The mapper uses `!= null`, which lets empty strings through.
    // Core does not emit empty-string episode IDs in practice, so
    // this is a pin-current-behavior test — if a future change
    // tightens the check to non-empty strings, update the
    // assertion to expect `metadata.episodeId` to be undefined.
    const m = toMemory(
      { id: 'm1', content: 'c', episode_id: '' },
      SCOPE,
    );
    expect(m.metadata?.episodeId).toBe('');
  });
});
