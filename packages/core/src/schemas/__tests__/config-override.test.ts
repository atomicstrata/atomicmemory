/**
 * @file Wire-contract tests for the per-request `config_override` field
 * threaded onto `IngestBodySchema` and `SearchBodySchema`.
 *
 * The schema is intentionally permissive — any object whose values are
 * primitives (boolean / number / string / null) passes. Unknown-key
 * detection happens at the route-handler layer (surfaces via the
 * `X-Atomicmem-Unknown-Override-Keys` response header and a warning
 * log), not here. Strictness at the schema layer would couple every
 * new RuntimeConfig field to a core release, which defeats the point
 * of a per-request mechanism.
 *
 * Invariants locked in here:
 *   1. Empty object parses successfully (no-op overlay).
 *   2. Known and unknown keys both pass the schema; differentiation is
 *      the handler's job.
 *   3. Non-primitive values (objects, arrays) reject — overlay is
 *      flat by contract.
 */

import { describe, expect, it } from 'vitest';
import { IngestBodySchema, SearchBodySchema, ConfigOverrideSchema } from '../memories';

const INGEST_BASE = { user_id: 'u', conversation: 'hi', source_site: 's' };
const SEARCH_BASE = { user_id: 'u', query: 'q' };

describe('ConfigOverrideSchema — permissive shape', () => {
  it('accepts an empty object', () => {
    const r = ConfigOverrideSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts a subset of known RuntimeConfig keys', () => {
    const r = ConfigOverrideSchema.safeParse({
      hybridSearchEnabled: true,
      mmrLambda: 0.8,
      audnCandidateThreshold: 0.9,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.hybridSearchEnabled).toBe(true);
      expect(r.data.mmrLambda).toBe(0.8);
    }
  });

  it('accepts keys not yet defined on RuntimeConfig (forward-compat)', () => {
    const r = ConfigOverrideSchema.safeParse({
      futureExperimentalFlag: true,
      someNewTunable: 42,
    });
    expect(r.success).toBe(true);
    // Runtime warning surfaces via X-Atomicmem-Unknown-Override-Keys;
    // not a schema concern.
  });

  it('accepts primitive values (boolean / number / string / null)', () => {
    const r = ConfigOverrideSchema.safeParse({
      flagA: true,
      numberA: 0.5,
      stringA: 'balanced',
      nullA: null,
    });
    expect(r.success).toBe(true);
  });

  it('rejects object values (overlay is flat)', () => {
    const r = ConfigOverrideSchema.safeParse({
      nested: { deep: true },
    });
    expect(r.success).toBe(false);
  });

  it('rejects array values (overlay is flat)', () => {
    const r = ConfigOverrideSchema.safeParse({
      list: [1, 2, 3],
    });
    expect(r.success).toBe(false);
  });
});

describe('IngestBodySchema — config_override threading', () => {
  it('parses without config_override', () => {
    const r = IngestBodySchema.safeParse(INGEST_BASE);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.configOverride).toBeUndefined();
  });

  it('accepts a valid config_override and emits it as configOverride', () => {
    const r = IngestBodySchema.safeParse({
      ...INGEST_BASE,
      config_override: { chunkedExtractionEnabled: true, audnCandidateThreshold: 0.95 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.configOverride?.chunkedExtractionEnabled).toBe(true);
      expect(r.data.configOverride?.audnCandidateThreshold).toBe(0.95);
    }
  });

  it('carries unknown keys through the schema layer', () => {
    const r = IngestBodySchema.safeParse({
      ...INGEST_BASE,
      config_override: { futureFlag: true },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.configOverride?.futureFlag).toBe(true);
  });
});

describe('SearchBodySchema — config_override threading', () => {
  it('parses without config_override', () => {
    const r = SearchBodySchema.safeParse(SEARCH_BASE);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.configOverride).toBeUndefined();
  });

  it('accepts a valid config_override and emits it as configOverride', () => {
    const r = SearchBodySchema.safeParse({
      ...SEARCH_BASE,
      config_override: { hybridSearchEnabled: true, mmrEnabled: false },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.configOverride?.hybridSearchEnabled).toBe(true);
      expect(r.data.configOverride?.mmrEnabled).toBe(false);
    }
  });

  it('carries unknown keys through the schema layer', () => {
    const r = SearchBodySchema.safeParse({
      ...SEARCH_BASE,
      config_override: { totallyMadeUp: 7 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.configOverride?.totallyMadeUp).toBe(7);
  });
});
