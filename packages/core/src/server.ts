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
import { startDeferredAudnScheduler, type DeferredAudnScheduler } from './services/deferred-audn-scheduler.js';
import { startCloudTraceSync, stopCloudTraceSync } from './services/cloud-trace-sync.js';

// Process-lifecycle signal handlers reference `runtime` via a closure
// captured AFTER `bootstrap()` resolves — wired below. Reconciler
// startup stays disabled until `buildReconcilerDeps` returns a
// non-null bundle backed by the active storage provider.
let runtime: CoreRuntime | null = null;
let deferredAudnScheduler: DeferredAudnScheduler | null = null;

async function bootstrap(): Promise<void> {
  runtime = await createCoreRuntime({ pool });
  const app = createApp(runtime);

  const prefetchCloudJwt = app.get('cloudJwtPrefetch') as (() => Promise<boolean>) | undefined;
  if (prefetchCloudJwt) {
    const ready = await prefetchCloudJwt();
    if (!ready) {
      console.warn(
        '[startup] Cloud JWKS prefetch did not complete; JWT auth remains degraded until keys load',
      );
    } else {
      console.log('[startup] Cloud JWKS prefetch ok');
    }
  }

  const check = await checkEmbeddingDimensions(runtime.pool, runtime.config);
  if (!check.ok) {
    console.error(`[startup] FATAL: ${check.message}`);
    process.exit(1);
  }
  console.log(`[startup] ${check.message}`);

  if (runtime.config.cloudTraceSync?.enabled) {
    await startCloudTraceSync(runtime.pool, runtime.config.cloudTraceSync);
    console.log('[startup] Cloud trace sync uploader started');
  }

  app.listen(runtime.config.port, () => {
    console.log(`AtomicMemory Core running on http://localhost:${runtime!.config.port}`);
  });

  // Drain the deferred-AUDN queue in the background so ingest stays fast while
  // AUDN is still applied. Opt-in: only when deferred AUDN is enabled.
  if (runtime.config.deferredAudnEnabled && runtime.config.deferredAudnAutoReconcile) {
    const memory = runtime.services.memory;
    deferredAudnScheduler = startDeferredAudnScheduler({
      reconcile: () => memory.reconcileDeferredAll(),
      intervalMs: runtime.config.deferredAudnReconcileIntervalMs,
      onError: (err) => console.error('[deferred-audn-scheduler] reconcile tick failed:', err),
    });
    console.log(
      `[startup] deferred-AUDN auto-reconcile every ${runtime.config.deferredAudnReconcileIntervalMs}ms`,
    );
  }
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
  if (deferredAudnScheduler) await deferredAudnScheduler.stop();
  await stopCloudTraceSync();
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
