/**
 * @file Replay tests for `toIngestResult` against captured ingest
 * + ingest/quick fixtures.
 *
 * Equality + semantic-contract halves. The mapper itself is small
 * (it just splits stored / updated / unchanged ID arrays), but
 * locking it in against real wire shapes catches regressions like
 * "core renamed `stored_memory_ids` to `memoryIds` and the SDK
 * silently produced empty arrays."
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { toIngestResult } from '../mappers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

interface RawIngestResponse {
  episode_id: string;
  memories_stored: number;
  memories_updated: number;
  stored_memory_ids: string[];
  updated_memory_ids: string[];
  [key: string]: unknown;
}

const fixtures: Array<{ label: string; raw: string; mapped: string }> = [
  { label: 'ingest', raw: 'ingest.raw.json', mapped: 'ingest.mapped.json' },
  { label: 'ingest-quick', raw: 'ingest-quick.raw.json', mapped: 'ingest-quick.mapped.json' },
];

describe.each(fixtures)('toIngestResult — fixture replay ($label)', ({ raw, mapped }) => {
  const rawResponse = JSON.parse(
    readFileSync(join(FIXTURES, raw), 'utf-8'),
  ) as RawIngestResponse;
  const expected = JSON.parse(
    readFileSync(join(FIXTURES, mapped), 'utf-8'),
  );

  it('maps to expected mapped fixture (equality)', () => {
    const actual = JSON.parse(JSON.stringify(toIngestResult(rawResponse)));
    expect(actual).toEqual(expected);
  });

  it('semantic contract: stored_memory_ids → IngestResult.created (length matches memories_stored)', () => {
    const result = toIngestResult(rawResponse);
    expect(result.created).toEqual(rawResponse.stored_memory_ids);
    expect(result.created.length).toBe(rawResponse.memories_stored);
  });

  it('semantic contract: updated_memory_ids → IngestResult.updated (length matches memories_updated)', () => {
    const result = toIngestResult(rawResponse);
    expect(result.updated).toEqual(rawResponse.updated_memory_ids);
    expect(result.updated.length).toBe(rawResponse.memories_updated);
  });
});
