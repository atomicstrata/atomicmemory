/**
 * @file Drift guard and preflight tests for MCP reserved metadata keys.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CALLER_ALLOWED_METADATA_KEYS,
  RESERVED_METADATA_KEYS,
  assertNoReservedMetadataKeys,
} from './reserved-metadata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCoreReservedKeys(): Set<string> {
  const corePath = join(
    __dirname,
    '../../core/src/db/repository-types.ts',
  );
  const text = readFileSync(corePath, 'utf8');
  const match = text.match(
    /export const RESERVED_METADATA_KEYS = new Set<string>\(\[\s*([\s\S]*?)\s*\]\);/,
  );
  assert.ok(match, 'could not parse RESERVED_METADATA_KEYS from core repository-types');
  const keys = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith("'"))
    .map((line) => line.match(/^'([^']+)'/)?.[1])
    .filter((key): key is string => Boolean(key));
  assert.ok(keys.length > 0, 'expected at least one reserved metadata key in core');
  return new Set(keys);
}

test('MCP reserved metadata keys match core RESERVED_METADATA_KEYS', () => {
  const core = loadCoreReservedKeys();
  const mcp = new Set(RESERVED_METADATA_KEYS);
  assert.deepEqual(mcp, core);
});

test('assertNoReservedMetadataKeys rejects topic and passes allowed keys', () => {
  assert.throws(
    () => assertNoReservedMetadataKeys({ topic: 'am-integrate-ux' }),
    /reserved key\(s\) \[topic\]/,
  );
  assert.doesNotThrow(() =>
    assertNoReservedMetadataKeys({ externalId: 'evt-1', dedupe_key: 'abc' }),
  );
  assert.doesNotThrow(() => assertNoReservedMetadataKeys(undefined));
});

// CALLER_ALLOWED_METADATA_KEYS advertises keys the schema/README call "safe";
// they are only truly safe while they stay out of core's RESERVED set. Guard the
// invariant here so a future core reservation is caught by CI rather than a
// caller silently hitting the reserved-key preflight.
test('CALLER_ALLOWED_METADATA_KEYS is disjoint from RESERVED_METADATA_KEYS', () => {
  const reserved = new Set<string>(RESERVED_METADATA_KEYS);
  const collision = CALLER_ALLOWED_METADATA_KEYS.filter((key) => reserved.has(key));
  assert.deepEqual(
    collision,
    [],
    `CALLER_ALLOWED_METADATA_KEYS overlaps RESERVED_METADATA_KEYS: [${collision.join(', ')}]. Remove the key from the allowed list or from core's reserved set — advertising a reserved key as safe misleads callers.`,
  );
});
