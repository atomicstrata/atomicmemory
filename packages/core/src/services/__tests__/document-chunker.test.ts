/**
 * Unit tests for the deterministic Phase 2 text chunker.
 *
 * Pure-function tests: same input → same chunks, same hashes,
 * same offsets. No DB / no embedding provider needed. Covers the
 * three invariants the indexer relies on: byte-identical inputs
 * produce byte-identical chunks, the (charStart, charEnd) range
 * covers the chunk content, and content_hash matches the SHA-256
 * of the chunk content.
 */

import { describe, expect, it } from 'vitest';
import {
  PHASE2_CHUNKER_VERSION,
  PHASE2_PARSER_VERSION,
  chunkText,
  hashChunkContent,
  hashIndexedText,
} from '../document-chunker.js';

describe('document-chunker — determinism', () => {
  it('same input produces byte-identical chunks across runs', () => {
    const text = 'sentence one. sentence two. sentence three. '.repeat(80);
    const a = chunkText(text);
    const b = chunkText(text);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
  });

  it('returns [] for empty / whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t')).toEqual([]);
  });

  it('returns a single chunk for short text under chunkSize', () => {
    const chunks = chunkText('short body of text');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toBe('short body of text');
  });
});

describe('document-chunker — chunk metadata invariants', () => {
  const longText = ('alpha beta gamma delta epsilon zeta eta theta iota kappa. ').repeat(80);

  it('content_hash is SHA-256 of content', () => {
    for (const chunk of chunkText(longText)) {
      expect(chunk.contentHash).toBe(hashChunkContent(chunk.content));
    }
  });

  it('chunk_index runs 0..n-1 with no gaps', () => {
    const indices = chunkText(longText).map((c) => c.chunkIndex);
    expect(indices).toEqual(Array.from({ length: indices.length }, (_, i) => i));
  });

  it('charStart < charEnd and charEnd <= text.length for every chunk', () => {
    for (const chunk of chunkText(longText)) {
      expect(chunk.charStart).toBeLessThan(chunk.charEnd);
      expect(chunk.charEnd).toBeLessThanOrEqual(longText.length);
    }
  });

  it('text.slice(charStart, charEnd) === content (offset invariant)', () => {
    const padded = '   ' + longText + '   ';
    for (const chunk of chunkText(padded)) {
      expect(padded.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it('offset invariant holds for short single-chunk input with surrounding whitespace', () => {
    const text = '   short body of text   ';
    const [chunk] = chunkText(text);
    expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    expect(chunk.content).toBe('short body of text');
  });

  it('hashIndexedText differs from hashChunkContent for the same byte string only by helper choice', () => {
    const s = 'hello world';
    expect(hashIndexedText(s)).toBe(hashChunkContent(s));
  });

  it('exposes pinned version constants', () => {
    expect(PHASE2_CHUNKER_VERSION).toBe('phase2-fixed-v1');
    expect(PHASE2_PARSER_VERSION).toBe('phase2-text-v1');
  });
});

describe('document-chunker — sliding window overlap', () => {
  it('respects chunkSize: no chunk longer than chunkSize chars', () => {
    const text = 'word '.repeat(2000);
    const opts = { chunkSize: 200, chunkOverlap: 20 };
    for (const chunk of chunkText(text, opts)) {
      expect(chunk.content.length).toBeLessThanOrEqual(opts.chunkSize);
    }
  });

  it('produces multiple chunks when text exceeds chunkSize', () => {
    const text = 'word '.repeat(800);
    expect(chunkText(text, { chunkSize: 300, chunkOverlap: 30 }).length).toBeGreaterThan(1);
  });

  it('cursor advances monotonically (no infinite loop on no-whitespace input)', () => {
    const text = 'A'.repeat(5000);
    const chunks = chunkText(text, { chunkSize: 500, chunkOverlap: 50 });
    const starts = chunks.map((c) => c.charStart);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
  });
});
