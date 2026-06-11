/**
 * GET /openapi.json contract test (radar C6).
 *
 * Asserts the unauthenticated OpenAPI route serves the committed spec with the
 * fields tooling depends on: a string `openapi` version, `info.version`, and a
 * `paths` object. Mounts the same handler `createApp` registers (serving the
 * eagerly-loaded `openApiSpec`) on a minimal Express app bound to an ephemeral
 * port, so the HTTP contract is exercised without a live Postgres — matching the
 * bind-ephemeral route-test style used elsewhere.
 */

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bindEphemeral, type BootedApp } from '../bind-ephemeral.js';
import { loadOpenApiSpec, openApiSpec } from '../openapi-spec.js';

interface ServedSpec {
  openapi: string;
  info: { version: string };
  paths: Record<string, unknown>;
}

describe('GET /openapi.json (radar C6)', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    const app = express();
    app.get('/openapi.json', (_req, res) => {
      res.json(openApiSpec);
    });
    booted = await bindEphemeral(app);
  });

  afterAll(async () => {
    await booted.close();
  });

  it('loadOpenApiSpec validates the committed spec contract fields', () => {
    const spec = loadOpenApiSpec();
    expect(typeof spec.openapi).toBe('string');
    expect(spec.openapi.length).toBeGreaterThan(0);
    expect(typeof spec.info.version).toBe('string');
    expect(spec.info.version.length).toBeGreaterThan(0);
    expect(typeof spec.paths).toBe('object');
  });

  it('returns 200 with openapi version, info.version, and paths', async () => {
    const res = await fetch(`${booted.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ServedSpec;
    expect(typeof body.openapi).toBe('string');
    expect(body.openapi.length).toBeGreaterThan(0);
    expect(typeof body.info.version).toBe('string');
    expect(body.info.version.length).toBeGreaterThan(0);
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
  });

  it('serves the same spec object the route handler loaded at startup', async () => {
    const res = await fetch(`${booted.baseUrl}/openapi.json`);
    const body = (await res.json()) as ServedSpec;
    expect(body.openapi).toBe(openApiSpec.openapi);
    expect(body.info.version).toBe(openApiSpec.info.version);
  });
});
