/**
 * Canonical HTTP-boot helper for tests and research harnesses.
 *
 * Binds a composed Express app (`createApp(createCoreRuntime({ pool }))`)
 * to an ephemeral port and returns the base URL plus a close handle.
 * This is the stable seam for any in-repo test or external research
 * harness that wants to exercise the HTTP contract against a live core
 * server without hard-coding port allocation.
 *
 * See https://docs.atomicstrata.ai/platform/consuming-core.
 */

import type express from 'express';

export interface BootedApp {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Bind an Express app to an ephemeral port and return its base URL + close handle. */
export async function bindEphemeral(app: ReturnType<typeof express>): Promise<BootedApp> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
