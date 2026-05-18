/**
 * AtomicMemory Core API Server — bootstrap entry point.
 *
 * Composes the runtime container, runs startup guards, builds the Express
 * app, and starts listening. All composition logic lives in `./app/`;
 * this file only owns the process lifecycle (boot → listen → shutdown).
 *
 * The `runtime` is the single source of truth for config, pool, repos,
 * and services. Nothing in this file reaches around it to import
 * singletons directly — if a consumer bootstraps with custom deps later,
 * shutdown and lifecycle still act on the right graph.
 */

import { pool } from './db/pool.js';
import { createCoreRuntime, type CoreRuntime } from './app/runtime-container.js';
import { createApp } from './app/create-app.js';
import { checkEmbeddingDimensions } from './app/startup-checks.js';

// Process-lifecycle signal handlers reference `runtime` via a closure
// captured AFTER `bootstrap()` resolves — wired below. Reconciler
// startup stays disabled until `buildReconcilerDeps` returns a
// non-null bundle backed by the active storage provider.
let runtime: CoreRuntime | null = null;

async function bootstrap(): Promise<void> {
  runtime = await createCoreRuntime({ pool });
  const app = createApp(runtime);

  const check = await checkEmbeddingDimensions(runtime.pool, runtime.config);
  if (!check.ok) {
    console.error(`[startup] FATAL: ${check.message}`);
    process.exit(1);
  }
  console.log(`[startup] ${check.message}`);

  app.listen(runtime.config.port, () => {
    console.log(`AtomicMemory Core running on http://localhost:${runtime!.config.port}`);
  });
}

bootstrap().catch((err) => {
  console.error('[startup] bootstrap failed:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection (non-fatal):', reason);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] Received ${signal}, closing...`);
  const closing = runtime ? runtime.pool.end() : pool.end();
  await closing;
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
