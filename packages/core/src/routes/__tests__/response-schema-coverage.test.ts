/**
 * @file Completeness gate for the response-schema map.
 *
 * The runtime response validator (`src/middleware/validate-response.ts`)
 * silently skips routes that aren't in its route→schema map. That
 * fail-open behavior means a future route rename or new route would
 * quietly drop validation without failing CI. This test closes that
 * maintenance gap: it walks the actual Express router stack for both
 * createMemoryRouter and createAgentRouter, and asserts every
 * registered route has an entry in the map (and vice-versa, so stale
 * keys are caught too).
 *
 * Fix when this fails: add the route to
 * `src/routes/response-schema-map.ts` with the schema it emits, or
 * add the schema alongside the route in `src/schemas/responses.ts`
 * first.
 */

import { describe, it, expect, vi } from 'vitest';

import type { Router } from 'express';
import { createMemoryRouter } from '../memories';
import { createAgentRouter } from '../agents';
import { createDocumentRouter } from '../documents';
import { documentRouterFixture } from './document-router-test-fixtures.js';
import {
  MEMORY_RESPONSE_SCHEMAS,
  AGENT_RESPONSE_SCHEMAS,
  DOCUMENT_RESPONSE_SCHEMAS,
} from '../response-schema-map';
import type { MemoryService } from '../../services/memory-service.js';
import type { AgentTrustRepository } from '../../db/agent-trust-repository.js';
import type { DocumentService } from '../../services/document-service.js';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
}

function enumerateRouteKeys(router: Router): string[] {
  const keys: string[] = [];
  // Express router internals: each layer with a `route` represents a
  // concrete registered path. Middleware layers (CORS, validateResponse)
  // have no `route` and are skipped.
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      keys.push(`${method} ${layer.route.path}`);
    }
  }
  return keys.sort();
}

describe('response-schema map covers every router-registered route', () => {
  it('every memory route has an entry in MEMORY_RESPONSE_SCHEMAS', () => {
    // Stubs suffice — router registration doesn't invoke service methods.
    const router = createMemoryRouter({} as unknown as MemoryService);
    const routes = enumerateRouteKeys(router);
    const missing = routes.filter((k) => !(k in MEMORY_RESPONSE_SCHEMAS));
    expect(missing).toEqual([]);
  });

  it('every agent route has an entry in AGENT_RESPONSE_SCHEMAS', () => {
    const router = createAgentRouter({} as unknown as AgentTrustRepository);
    const routes = enumerateRouteKeys(router);
    const missing = routes.filter((k) => !(k in AGENT_RESPONSE_SCHEMAS));
    expect(missing).toEqual([]);
  });

  it('no MEMORY_RESPONSE_SCHEMAS key points at a non-existent route', () => {
    const router = createMemoryRouter({} as unknown as MemoryService);
    const routes = new Set(enumerateRouteKeys(router));
    const stale = Object.keys(MEMORY_RESPONSE_SCHEMAS).filter(
      (k) => !routes.has(k),
    );
    expect(stale).toEqual([]);
  });

  it('no AGENT_RESPONSE_SCHEMAS key points at a non-existent route', () => {
    const router = createAgentRouter({} as unknown as AgentTrustRepository);
    const routes = new Set(enumerateRouteKeys(router));
    const stale = Object.keys(AGENT_RESPONSE_SCHEMAS).filter(
      (k) => !routes.has(k),
    );
    expect(stale).toEqual([]);
  });

  it('every document route has an entry in DOCUMENT_RESPONSE_SCHEMAS', () => {
    const router = createDocumentRouter({} as unknown as DocumentService, documentRouterFixture());
    const routes = enumerateRouteKeys(router);
    const missing = routes.filter((k) => !(k in DOCUMENT_RESPONSE_SCHEMAS));
    expect(missing).toEqual([]);
  });

  it('no DOCUMENT_RESPONSE_SCHEMAS key points at a non-existent route', () => {
    const router = createDocumentRouter({} as unknown as DocumentService, documentRouterFixture());
    const routes = new Set(enumerateRouteKeys(router));
    const stale = Object.keys(DOCUMENT_RESPONSE_SCHEMAS).filter(
      (k) => !routes.has(k),
    );
    expect(stale).toEqual([]);
  });
});
