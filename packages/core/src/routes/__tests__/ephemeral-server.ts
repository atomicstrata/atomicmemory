/**
 * @file Tiny shared helpers for the route test suites' ephemeral
 * Express servers.
 *
 * Every router test mounts its router on a fresh `express()` app and
 * listens on port 0 so the OS picks a free port. The listen / address
 * dance and the matching `server.close()` boilerplate are identical
 * across `admin.test.ts`, `storage-capabilities-route.test.ts`, and
 * `storage-routes-fixtures.ts`; centralising them here keeps fallow's
 * duplicate detector clean without hiding the per-suite router wiring
 * (which still happens at the call site).
 */

import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Start an Express app on an OS-chosen port and resolve once it is
 * accepting connections. Returns the live `baseUrl` (with `127.0.0.1`
 * loopback so tests never hit a real network interface) and the
 * underlying `http.Server` handle. Callers close the handle in their
 * `afterAll` via {@link closeEphemeralServer}.
 */
export async function startEphemeralServer(
  app: Express,
): Promise<{ baseUrl: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

/**
 * Counterpart to {@link startEphemeralServer}. Promise resolves once
 * the underlying server has closed all open connections; rejections
 * propagate so tests fail loudly instead of leaking handles.
 */
export function closeEphemeralServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
