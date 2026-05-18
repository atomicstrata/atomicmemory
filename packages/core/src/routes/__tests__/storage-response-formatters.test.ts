/**
 * Commit G regression tests for `formatStoredArtifact`'s public
 * `metadata` projection.
 *
 * Write paths validate metadata with `validateArtifactMetadata`
 * (closed leaf-type set: string | number | boolean; ≤4 KiB), but
 * the formatter previously cast the raw JSONB column through
 * `as Record<string, string | number | boolean>`. A row that
 * was inserted before that check existed, or via a direct SQL ops
 * fix, could carry arrays, nested objects, or `null` — and the
 * cast would leak them onto the wire as arbitrary JSON.
 *
 * The new defensive projection iterates the row's own keys and
 * keeps ONLY string/number/boolean leaves; everything else is
 * dropped. These tests plant malformed metadata at the row level
 * and assert the projected wire object contains only the safe
 * subset.
 */

import { describe, it, expect } from 'vitest';
import { formatStoredArtifact } from '../storage-response-formatters.js';
import type { StorageArtifactRow } from '../../db/storage-artifact-repository.js';

function makeRow(metadata: unknown): StorageArtifactRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'u1',
    orgId: null,
    projectId: null,
    provider: 'local_fs',
    mode: 'managed',
    uri: 'local-fs://s/abcdef0123456789abcdef0123456789/x.bin',
    status: 'stored',
    sizeBytes: 1,
    contentType: 'text/plain',
    plaintextHash: null,
    storedHash: null,
    contentEncoding: 'identity',
    discloseContentHash: false,
    identifiers: {},
    lifecycle: {},
    replication: null,
    verification: null,
    retrieval: null,
    providerDetails: {},
    // Cast through `unknown` so the row's metadata type allows the
    // hostile shapes (arrays / nested objects / nulls) the
    // production column technically permits via direct SQL.
    metadata: metadata as Record<string, string | number | boolean>,
    lastError: null,
    putAttemptId: null,
    deleteAttemptId: null,
    createdAt: new Date('2026-05-11T00:00:00.000Z'),
    updatedAt: new Date('2026-05-11T00:00:00.000Z'),
    deletedAt: null,
  };
}

describe('formatStoredArtifact — defensive public metadata projection', () => {
  it('passes through a clean leaf-type metadata object verbatim', () => {
    const out = formatStoredArtifact(makeRow({ source: 'drive', size: 42, archived: true }));
    expect(out.metadata).toEqual({ source: 'drive', size: 42, archived: true });
  });

  it('drops nested-object values that snuck past the write-side validator', () => {
    const out = formatStoredArtifact(
      makeRow({ keep: 'ok', leaked: { secret: 'x', nested: { deep: 'y' } } }),
    );
    expect(out.metadata).toEqual({ keep: 'ok' });
    expect(JSON.stringify(out.metadata)).not.toContain('secret');
    expect(JSON.stringify(out.metadata)).not.toContain('nested');
  });

  it('drops array values', () => {
    const out = formatStoredArtifact(makeRow({ keep: 'ok', tags: ['a', 'b'] }));
    expect(out.metadata).toEqual({ keep: 'ok' });
  });

  it('drops null values', () => {
    const out = formatStoredArtifact(makeRow({ keep: 'ok', empty: null }));
    expect(out.metadata).toEqual({ keep: 'ok' });
  });

  it('returns {} when the entire metadata column is non-object', () => {
    expect(formatStoredArtifact(makeRow(null)).metadata).toEqual({});
    expect(formatStoredArtifact(makeRow('a-string')).metadata).toEqual({});
    expect(formatStoredArtifact(makeRow(42)).metadata).toEqual({});
    expect(formatStoredArtifact(makeRow([1, 2, 3])).metadata).toEqual({});
  });

  it('drops a hostile mix of leaf + nested without throwing', () => {
    const out = formatStoredArtifact(makeRow({
      kept_str: 's', kept_num: 1, kept_bool: false,
      dropped_obj: { x: 1 }, dropped_arr: [1], dropped_null: null,
    }));
    expect(out.metadata).toEqual({ kept_str: 's', kept_num: 1, kept_bool: false });
  });
});
