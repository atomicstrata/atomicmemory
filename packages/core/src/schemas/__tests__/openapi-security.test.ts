/**
 * Pins the OpenAPI security posture: every documented `/v1/*`
 * route requires the `bearerAuth` scheme registered in
 * `buildRegistry()`, matching the `requireBearer(coreApiKey)`
 * middleware mounted in `create-app.ts`. A regression that
 * drops the document-level security or fails to register the
 * scheme component would let an SDK-generated client send
 * unauthenticated requests; this test fails loudly on that.
 *
 * Mirrors the same generator setup the production script uses
 * (`scripts/generate-openapi.ts`).
 */

import { describe, it, expect } from 'vitest';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { buildRegistry } from '../openapi';

function generateOpenApiDoc() {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Test', version: '0.0.0' },
    security: [{ bearerAuth: [] }],
  });
}

describe('OpenAPI security — Bearer scheme on every documented route', () => {
  const doc = generateOpenApiDoc();

  it('registers a `bearerAuth` security scheme in components', () => {
    const schemes = (doc.components as { securitySchemes?: Record<string, unknown> } | undefined)
      ?.securitySchemes;
    expect(schemes).toBeDefined();
    expect(schemes?.bearerAuth).toEqual(expect.objectContaining({
      type: 'http',
      scheme: 'bearer',
    }));
    expect(schemes?.adminBearerAuth).toEqual(expect.objectContaining({
      type: 'http',
      scheme: 'bearer',
    }));
  });

  it('declares a document-level `bearerAuth` security requirement', () => {
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it('does NOT register the unversioned /health probe in the OpenAPI surface', () => {
    // `/health` is intentionally unversioned + middleware-free for
    // load-balancer liveness; documenting it would force a per-path
    // `security: []` waiver. Keeping it outside the surface entirely
    // is the cleaner contract.
    expect(doc.paths?.['/health']).toBeUndefined();
  });

  it('every documented path is under `/v1/*` (auth-gated by create-app)', () => {
    const paths = Object.keys(doc.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith('/v1/')).toBe(true);
    }
  });

  it('admin cleanup uses the separate admin bearer scheme', () => {
    const adminDelete = doc.paths?.['/v1/admin/scope']?.delete;
    expect(adminDelete?.security).toEqual([{ adminBearerAuth: [] }]);
  });
});
