/**
 * Self-check coverage for `verifyCapabilitiesDescriptor` (radar audit #8).
 *
 * The descriptor Radar negotiates against must reflect genuinely-mounted
 * routes. These tests confirm the default descriptor passes against a router
 * carrying the real backing routes, and that the check THROWS when an
 * advertised capability's backing route is missing or its temporal control is
 * unsupported — so the descriptor can never silently over-advertise.
 */

import express, { type Router } from 'express';
import { describe, expect, it } from 'vitest';

import { CORE_CAPABILITIES, type CoreCapabilities } from '../capabilities-descriptor.js';
import { verifyCapabilitiesDescriptor } from '../verify-capabilities.js';
import { SearchBodySchema } from '../../schemas/memories.js';

/** The route signatures the real memory router mounts that back the descriptor. */
const BACKING_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string }> = [
  { method: 'post', path: '/search' },
  { method: 'post', path: '/search/fast' },
  { method: 'post', path: '/ingest/quick' },
  { method: 'get', path: '/health' },
  { method: 'get', path: '/:id/audit' },
];

function routerWith(routes: ReadonlyArray<{ method: 'get' | 'post'; path: string }>): Router {
  const router = express.Router();
  for (const { method, path } of routes) {
    router[method](path, (_req, res) => res.end());
  }
  return router;
}

function descriptorWith(overrides: Partial<CoreCapabilities>): CoreCapabilities {
  return { ...CORE_CAPABILITIES, ...overrides, extensions: { ...CORE_CAPABILITIES.extensions, ...overrides.extensions } };
}

describe('verifyCapabilitiesDescriptor', () => {
  it('passes when every advertised capability is backed by a mounted route', () => {
    expect(() =>
      verifyCapabilitiesDescriptor(CORE_CAPABILITIES, routerWith(BACKING_ROUTES), SearchBodySchema),
    ).not.toThrow();
  });

  it('throws when an advertised capability route is not mounted', () => {
    const missingFastPath = BACKING_ROUTES.filter((r) => r.path !== '/search/fast');
    expect(() =>
      verifyCapabilitiesDescriptor(CORE_CAPABILITIES, routerWith(missingFastPath), SearchBodySchema),
    ).toThrow(/deterministic_fast_path.*not mounted/s);
  });

  it('throws when versioning is advertised but the audit route is absent', () => {
    const noAudit = BACKING_ROUTES.filter((r) => r.path !== '/:id/audit');
    expect(() =>
      verifyCapabilitiesDescriptor(CORE_CAPABILITIES, routerWith(noAudit), SearchBodySchema),
    ).toThrow(/extensions\.versioning.*not mounted/s);
  });

  it('does not require a route for a capability that is advertised false', () => {
    const noAudit = BACKING_ROUTES.filter((r) => r.path !== '/:id/audit');
    const descriptor = descriptorWith({ extensions: { health: true, versioning: false, temporal: true } });
    expect(() =>
      verifyCapabilitiesDescriptor(descriptor, routerWith(noAudit), SearchBodySchema),
    ).not.toThrow();
  });

  it('throws when temporal is advertised but the schema rejects as_of', () => {
    const nonTemporalSchema = SearchBodySchema.transform(() => ({ asOf: undefined }));
    expect(() =>
      verifyCapabilitiesDescriptor(CORE_CAPABILITIES, routerWith(BACKING_ROUTES), nonTemporalSchema),
    ).toThrow(/extensions\.temporal.*as_of/s);
  });
});
