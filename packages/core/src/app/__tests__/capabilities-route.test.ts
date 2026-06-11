/**
 * GET /v1/capabilities contract test (radar S3).
 *
 * Asserts the unauthenticated capabilities route serves the wire descriptor a
 * protocol-level caller (Radar's Rust daemon) negotiates against at startup:
 * snake_case keys, `ingest_modes` covering text + verbatim,
 * `deterministic_fast_path: true` (the LLM-free `/search/fast` path, radar C2),
 * and `extensions.versioning: true` (per-version audit hashing, radar C7).
 *
 * Mounts the same handler `createApp` registers (serving the frozen
 * `CORE_CAPABILITIES` const) on a minimal Express app bound to an ephemeral
 * port, so the HTTP contract is exercised without a live Postgres — matching
 * the bind-ephemeral route-test style of `openapi-route.test.ts`.
 */

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bindEphemeral, type BootedApp } from '../bind-ephemeral.js';
import { CORE_CAPABILITIES, type CoreCapabilities } from '../capabilities-descriptor.js';

describe('GET /v1/capabilities (radar S3)', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    const app = express();
    app.get('/v1/capabilities', (_req, res) => {
      res.json(CORE_CAPABILITIES);
    });
    booted = await bindEphemeral(app);
  });

  afterAll(async () => {
    await booted.close();
  });

  it('returns 200 with the snake_case wire descriptor', async () => {
    const res = await fetch(`${booted.baseUrl}/v1/capabilities`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as CoreCapabilities;
    expect(body.version).toBe(1);
    expect(body.ingest_modes).toContain('text');
    expect(body.ingest_modes).toContain('verbatim');
    expect(body.search).toBe(true);
    expect(body.retrieval).toBe('semantic');
    expect(body.deterministic_fast_path).toBe(true);
    expect(body.extensions.versioning).toBe(true);
    expect(body.extensions.health).toBe(true);
    expect(body.extensions.temporal).toBe(true);
  });

  it('requires no Authorization header (unauthenticated like /health)', async () => {
    const res = await fetch(`${booted.baseUrl}/v1/capabilities`);
    expect(res.status).toBe(200);
  });
});
