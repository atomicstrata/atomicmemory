/**
 * @file Provider-contract schema validation tests (radar S1)
 *
 * Validates a known-good ingest input and a known-good search result page
 * (including the radar retrieval receipt) against the published v1 JSON
 * Schemas under packages/sdk/schema/v1/. Uses ajv (draft 2020-12) for real
 * structural validation, and asserts a malformed payload is rejected so the
 * schema is shown to discriminate, not rubber-stamp.
 */

import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv/dist/2020';

import contractSchema from '../../../schema/v1/provider-contract.schema.json';
import ingestInputSchema from '../../../schema/v1/ingest-input.schema.json';
import searchResultPageSchema from '../../../schema/v1/search-result-page.schema.json';

function buildValidators(): {
  ingest: ValidateFunction;
  searchPage: ValidateFunction;
} {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(contractSchema);
  return {
    ingest: ajv.compile(ingestInputSchema),
    searchPage: ajv.compile(searchResultPageSchema),
  };
}

const GOOD_INGEST = {
  mode: 'verbatim',
  content: 'The deploy gate requires a green PR check.',
  scope: { user: 'u1', namespace: 'team-radar' },
  metadata: { source: 'radar' },
} as const;

const GOOD_SEARCH_PAGE = {
  results: [
    {
      memory: {
        id: 'mem_1',
        content: 'The deploy gate requires a green PR check.',
        scope: { user: 'u1' },
        createdAt: '2026-05-30T12:00:00.000Z',
      },
      score: 0.82,
      relevance: 0.74,
      version_id: 'ver_9',
      observed_at: '2026-05-30T12:00:00.000Z',
    },
  ],
  retrieval: {
    embedding_provider: 'ollama',
    embedding_model: 'mxbai-embed-large',
    embedding_model_version: 'mxbai-embed-large',
    embedding_dimensions: 1024,
    query_text: 'deploy gate',
    candidate_ids: ['mem_1'],
    trace_id: 'trace_abc',
  },
} as const;

describe('provider-contract v1 schemas', () => {
  it('publishes schemas carrying an explicit version and $id', () => {
    for (const schema of [contractSchema, ingestInputSchema, searchResultPageSchema]) {
      expect(schema.version).toBe(1);
      expect(schema.$id).toContain('/v1/');
    }
  });

  it('accepts a known-good verbatim ingest input', () => {
    const { ingest } = buildValidators();
    expect(ingest(GOOD_INGEST)).toBe(true);
  });

  it('accepts a known-good search result page with a retrieval receipt', () => {
    const { searchPage } = buildValidators();
    expect(searchPage(GOOD_SEARCH_PAGE)).toBe(true);
  });

  it('rejects an ingest input with an unknown mode', () => {
    const { ingest } = buildValidators();
    expect(ingest({ ...GOOD_INGEST, mode: 'binary' })).toBe(false);
  });

  // The SDK forwards content_class to core on the verbatim path, and core
  // refuses an unclassified verbatim write under RAW_CONTENT_POLICY=reject.
  // VerbatimIngest is additionalProperties:false, so the schema has to carry
  // the field or the very payload the SDK emits is contract-invalid.
  // Verbatim only, deliberately: core also consults content_class on
  // extraction paths for audit-transcript redaction, but exposing it there
  // changes what is durably retained — tracked as tech debt, not done here.
  it.each(['summary', 'redacted', 'raw'])('accepts content_class %s on verbatim', (contentClass) => {
    const { ingest } = buildValidators();
    expect(ingest({ ...GOOD_INGEST, content_class: contentClass })).toBe(true);
  });

  it('rejects an unknown content_class', () => {
    const { ingest } = buildValidators();
    expect(ingest({ ...GOOD_INGEST, content_class: 'public' })).toBe(false);
  });

  it('still rejects an unknown ingest field', () => {
    // Guards the guard: proves additionalProperties:false is doing work, so
    // the acceptance above means the field was added rather than the schema
    // having stopped constraining anything.
    const { ingest } = buildValidators();
    expect(ingest({ ...GOOD_INGEST, not_a_real_field: 'x' })).toBe(false);
  });

  it('rejects a retrieval receipt missing trace_id', () => {
    const { searchPage } = buildValidators();
    const receipt: Record<string, unknown> = { ...GOOD_SEARCH_PAGE.retrieval };
    delete receipt.trace_id;
    const page = { ...GOOD_SEARCH_PAGE, retrieval: receipt };
    expect(searchPage(page)).toBe(false);
  });
});
