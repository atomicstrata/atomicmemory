/**
 * @file Startup self-check that the advertised wire capabilities descriptor
 * reflects what the running core actually supports.
 *
 * `CORE_CAPABILITIES` is a frozen literal that a protocol-level
 * negotiation trusts at face value. If the literal ever advertised a
 * capability whose backing route is not mounted (a refactor drops a route, a
 * feature is gated off, etc.) such a caller would negotiate against a feature that
 * does not exist. This module verifies each advertised capability against the
 * genuinely-mounted route table (and, for temporal, the search schema) and
 * throws at startup if the descriptor over-advertises. The descriptor served
 * at `GET /v1/capabilities` is therefore the *verified* descriptor.
 *
 * The check is read-only and deterministic: it inspects the Express router's
 * registered route layers (`layer.route.path` / `layer.route.methods`, stable
 * in Express 5 for direct `router.<method>(path, ...)` registrations) and a
 * single schema parse. No wall-clock, randomness, or network.
 */

import type { Router } from 'express';
import type { ZodTypeAny } from 'zod';
import type { CoreCapabilities } from './capabilities-descriptor.js';

/** A method+path the memory router must have mounted to back a capability. */
interface RequiredRoute {
  method: 'get' | 'post';
  path: string;
}

/**
 * Collect the `{method, path}` pairs the memory router actually registered.
 * Only direct route layers carry a `route`; middleware layers are skipped.
 */
function collectMountedRoutes(memoryRouter: Router): ReadonlySet<string> {
  const mounted = new Set<string>();
  for (const layer of memoryRouter.stack) {
    const route = (layer as { route?: { path: string; methods: Record<string, boolean> } }).route;
    if (!route) continue;
    for (const method of Object.keys(route.methods)) {
      mounted.add(`${method} ${route.path}`);
    }
  }
  return mounted;
}

/** Capability label → the memory-router route that must exist to back it. */
const CAPABILITY_ROUTES: ReadonlyArray<{ label: string; advertised: (c: CoreCapabilities) => boolean; route: RequiredRoute }> = [
  { label: 'search', advertised: (c) => c.search, route: { method: 'post', path: '/search' } },
  {
    label: 'deterministic_fast_path',
    advertised: (c) => c.deterministic_fast_path,
    route: { method: 'post', path: '/search/fast' },
  },
  { label: 'ingest_modes.verbatim', advertised: (c) => c.ingest_modes.includes('verbatim'), route: { method: 'post', path: '/ingest/quick' } },
  { label: 'extensions.health', advertised: (c) => c.extensions.health, route: { method: 'get', path: '/health' } },
  {
    label: 'extensions.versioning',
    advertised: (c) => c.extensions.versioning,
    route: { method: 'get', path: '/:id/audit' },
  },
];

/**
 * Verify the temporal extension: `/v1/memories/search` must genuinely accept
 * the `as_of` temporal control. Probe the search schema by parsing a minimal
 * valid body carrying `as_of` and confirm the parsed result surfaces it.
 */
function verifyTemporalCapability(descriptor: CoreCapabilities, searchBodySchema: ZodTypeAny): void {
  if (!descriptor.extensions.temporal) return;
  const probeAsOf = '2024-01-01T00:00:00.000Z';
  const parsed = searchBodySchema.safeParse({ user_id: 'capability-probe', query: 'probe', as_of: probeAsOf });
  const surfacedAsOf = parsed.success ? (parsed.data as { asOf?: unknown }).asOf : undefined;
  if (surfacedAsOf !== probeAsOf) {
    throw new Error(
      `capabilities descriptor advertises extensions.temporal=true but the search ` +
        `schema does not accept the 'as_of' temporal control. Either wire temporal ` +
        `retrieval or set extensions.temporal=false in capabilities-descriptor.ts.`,
    );
  }
}

/**
 * Throw at startup if `descriptor` advertises any capability whose backing
 * route is not mounted on `memoryRouter`, or whose temporal control is not
 * accepted by `searchBodySchema`. Called from `createApp` after the memory
 * router is mounted.
 */
export function verifyCapabilitiesDescriptor(
  descriptor: CoreCapabilities,
  memoryRouter: Router,
  searchBodySchema: ZodTypeAny,
): void {
  const mounted = collectMountedRoutes(memoryRouter);
  for (const { label, advertised, route } of CAPABILITY_ROUTES) {
    if (!advertised(descriptor)) continue;
    const signature = `${route.method} ${route.path}`;
    if (!mounted.has(signature)) {
      throw new Error(
        `capabilities descriptor advertises '${label}' but its backing route ` +
          `'${route.method.toUpperCase()} /v1/memories${route.path}' is not mounted. ` +
          `Either wire the route or stop advertising the capability in ` +
          `capabilities-descriptor.ts.`,
      );
    }
  }
  verifyTemporalCapability(descriptor, searchBodySchema);
}
