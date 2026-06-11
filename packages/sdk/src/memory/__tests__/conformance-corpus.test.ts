/**
 * @file Cross-provider conformance corpus harness (radar S4)
 *
 * Loads the versioned conformance corpus under
 * packages/sdk/schema/v1/conformance/ and validates every fixture's
 * request payload and expected-response *shape* against the v1 JSON
 * Schemas (radar S1). This is the harness a future MemoryProvider runs
 * against to prove it speaks the v1 contract: it validates structure,
 * not exact values.
 *
 * Validation uses ajv (draft 2020-12). The canonical provider-contract
 * schema is registered by its `$id` so cross-file `$ref`s in the entry
 * schemas (ingest-input, search-result-page, capabilities-descriptor)
 * and inline `#/$defs/...` pointers resolve.
 *
 * Producer-sourced golden (radar audit #5): the search receipt sub-shape was
 * previously hand-authored in this corpus AND hand-replicated in the Rust Radar
 * daemon, with no producer fixture. This file now also loads CORE's committed
 * golden search-response (`packages/core/test/fixtures/radar-search-response.json`,
 * emitted by core's real `formatSearchResponse` and pinned by a core test) and
 * validates its `retrieval` receipt and per-result receipt fields against the
 * v1 `RetrievalReceipt` / `SearchResult` `$defs`. The schema therefore validates
 * the REAL producer output, not a separate hand-authored shape.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv/dist/2020';

/** Directory holding the v1 schemas and the conformance/ corpus. */
const SCHEMA_V1_DIR = resolve(__dirname, '..', '..', '..', 'schema', 'v1');
const CONFORMANCE_DIR = resolve(SCHEMA_V1_DIR, 'conformance');
/** Canonical `$id` prefix for v1 schemas; referenced by entry schemas. */
const SCHEMA_ID_BASE =
  'https://schemas.atomicmemory.dev/provider-contract/v1';
/**
 * CORE's committed producer golden (radar audit #5). Emitted by core's real
 * `formatSearchResponse` and pinned by a core test; the single source of truth
 * for the `/search/fast` wire shape that the Rust Radar daemon vendors.
 */
const CORE_SEARCH_GOLDEN_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'core',
  'test',
  'fixtures',
  'radar-search-response.json',
);

interface ConformanceCase {
  name: string;
  file: string;
}

interface ConformanceManifest {
  version: number;
  cases: ConformanceCase[];
}

interface ConformanceFixture {
  name: string;
  operation: string;
  request_schema: string | null;
  request: unknown;
  response_schema: string;
  expected_response: unknown;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Resolve a corpus `*_schema` reference to a JSON-Schema ref object ajv
 * can compile. A reference is either a bare entry-schema filename
 * (`ingest-input.schema.json`) or a filename with a JSON-pointer
 * fragment into the contract `$defs` (`provider-contract.schema.json#/$defs/IngestResult`).
 * Both map onto the canonical `$id` space registered below.
 */
function refObjectFor(schemaRef: string): { $ref: string } {
  const [file, fragment] = schemaRef.split('#');
  const base = `${SCHEMA_ID_BASE}/${file}`;
  return { $ref: fragment ? `${base}#${fragment}` : base };
}

let ajv: Ajv2020;
const compiledCache = new Map<string, ValidateFunction>();

function validatorFor(schemaRef: string): ValidateFunction {
  const cached = compiledCache.get(schemaRef);
  if (cached) return cached;
  const compiled = ajv.compile(refObjectFor(schemaRef));
  compiledCache.set(schemaRef, compiled);
  return compiled;
}

beforeAll(() => {
  ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // Register every entry schema + the canonical contract by `$id` so all
  // cross-file `$ref`s resolve regardless of which one a fixture targets.
  for (const file of readdirSync(SCHEMA_V1_DIR)) {
    if (file.endsWith('.schema.json')) {
      ajv.addSchema(readJson(resolve(SCHEMA_V1_DIR, file)));
    }
  }
});

const manifest = readJson<ConformanceManifest>(
  resolve(CONFORMANCE_DIR, 'manifest.json'),
);

describe('conformance corpus v1 (radar S4)', () => {
  it('manifest declares version 1 and lists every contract operation', () => {
    expect(manifest.version).toBe(1);
    const operations = manifest.cases.map((c) =>
      readJson<ConformanceFixture>(resolve(CONFORMANCE_DIR, c.file)).operation,
    );
    expect(new Set(operations)).toEqual(
      new Set(['ingest', 'search', 'capabilities']),
    );
  });

  it.each(manifest.cases.map((c) => [c.name, c.file] as const))(
    'case %s: request + expected_response validate against the v1 schemas',
    (_name, file) => {
      const fixture = readJson<ConformanceFixture>(
        resolve(CONFORMANCE_DIR, file),
      );

      if (fixture.request_schema !== null) {
        const validateRequest = validatorFor(fixture.request_schema);
        expect(
          validateRequest(fixture.request),
          JSON.stringify(validateRequest.errors),
        ).toBe(true);
      }

      const validateResponse = validatorFor(fixture.response_schema);
      expect(
        validateResponse(fixture.expected_response),
        JSON.stringify(validateResponse.errors),
      ).toBe(true);
    },
  );

  it('rejects a verbatim ingest fixture mutated to an unknown mode', () => {
    const fixture = readJson<ConformanceFixture>(
      resolve(CONFORMANCE_DIR, 'ingest-verbatim.json'),
    );
    const validateRequest = validatorFor(fixture.request_schema as string);
    const broken = { ...(fixture.request as object), mode: 'binary' };
    expect(validateRequest(broken)).toBe(false);
  });
});

/** Minimal view of the core producer golden the receipt checks consume. */
interface CoreSearchGolden {
  retrieval: unknown;
  memories: Array<Record<string, unknown>>;
}

describe('core-emitted search golden validates against v1 schemas (radar audit #5)', () => {
  const golden = readJson<CoreSearchGolden>(CORE_SEARCH_GOLDEN_PATH);

  it("the producer golden's retrieval receipt validates against RetrievalReceipt", () => {
    const validate = validatorFor(
      'provider-contract.schema.json#/$defs/RetrievalReceipt',
    );
    expect(validate(golden.retrieval), JSON.stringify(validate.errors)).toBe(
      true,
    );
  });

  it('every producer-golden memory carries the per-result receipt fields', () => {
    // version_id/observed_at are the per-hit receipt fields the Rust daemon
    // reads off each core memory row; assert the real producer bytes carry the
    // v1-typed shapes (string|null version_id, ISO-8601 observed_at).
    const validate = validatorFor(
      'provider-contract.schema.json#/$defs/SearchResult',
    );
    for (const memory of golden.memories) {
      const receiptView = {
        memory: {
          id: memory.id,
          content: memory.content,
          scope: { user: 'u' },
          createdAt: memory.created_at,
        },
        score: memory.score,
        version_id: memory.version_id,
        observed_at: memory.observed_at,
      };
      expect(validate(receiptView), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
