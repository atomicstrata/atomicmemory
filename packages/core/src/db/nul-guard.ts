/**
 * @file `installNulGuard` — the pg query-layer backstop that rejects a raw NUL
 * byte (U+0000) in any bound query parameter before it reaches Postgres.
 *
 * Postgres cannot store `\x00` in `text` / `varchar` / `jsonb`; an un-rejected
 * NUL turns documented client input into a driver-level 500 instead of a
 * validated 400. The request-boundary guards (`middleware/reject-nul-bytes.ts`)
 * and per-field schema refines (`schemas/common.ts`) catch the common channels,
 * but they are applied per-channel and are leaky by construction: every new
 * input surface (a header, an object key, a future route) must remember to
 * re-add the guard. This wraps the single `pg.Pool` the process owns so EVERY
 * bound parameter — query, body, path, header, and any future channel —
 * converges on one check. See release-1.1.0 QA (`core-robustness:nul.*`) and the
 * follow-up principal audit.
 *
 * `pg` exposes no parameter-interceptor hook, so the wrap is a thin monkeypatch
 * of `pool.query` and the `query` method of clients handed out by
 * `pool.connect()` (transactions). Both are idempotent via a per-instance
 * symbol marker. Binary safety: `scanForNul` skips `Buffer` values, so `bytea`
 * parameters (managed-upload bodies) are never treated as text.
 */

import type pg from 'pg';
import { scanForNul } from '../nul-scan.js';

/**
 * Thrown when a bound query parameter carries a NUL byte. Mapped to a 400 by
 * `routes/route-errors.ts` (the storage error handler falls through to it), so
 * the backstop surfaces as a validated client error, not a 500.
 */
export class NulByteParameterError extends Error {
  constructor(
    message = 'a bound query parameter must not contain NUL bytes (Postgres text/jsonb cannot store \\x00)',
  ) {
    super(message);
    this.name = 'NulByteParameterError';
  }
}

/** A pg `Pool` or `PoolClient` — both expose a variadic `query(...)`. */
interface Queryable {
  query: (...args: unknown[]) => unknown;
}

/** Extract the positional `values` array from a pg `query(...)` call's args. */
function extractValues(args: readonly unknown[]): unknown {
  const first = args[0];
  if (typeof first === 'string') return Array.isArray(args[1]) ? args[1] : [];
  if (first !== null && typeof first === 'object') {
    return (first as { values?: unknown }).values ?? [];
  }
  return [];
}

/** Throw {@link NulByteParameterError} if any bound parameter carries a NUL. */
function assertCleanParams(args: readonly unknown[]): void {
  const result = scanForNul(extractValues(args));
  if (result === 'nul') throw new NulByteParameterError();
  if (result === 'too-deep') {
    throw new NulByteParameterError('a bound query parameter is too deeply nested');
  }
}

/** Per-instance marker so a pooled client / pool is wrapped at most once. */
const GUARDED: unique symbol = Symbol('atomicmemory.nulGuardInstalled');

function isGuarded(target: object): boolean {
  return (target as Record<symbol, boolean>)[GUARDED] === true;
}

function markGuarded(target: object): void {
  (target as Record<symbol, boolean>)[GUARDED] = true;
}

/**
 * Wrap a queryable's `query` so NUL-bearing parameters are rejected before
 * execution. The rejection mirrors pg's own contract: callback form invokes the
 * callback with the error; promise form returns a rejected promise (never a
 * synchronous throw), so `await` and `.catch` callers both observe it.
 */
function guardQueryable(target: Queryable): void {
  if (isGuarded(target)) return;
  markGuarded(target);
  const original = target.query.bind(target);
  target.query = (...args: unknown[]): unknown => {
    try {
      assertCleanParams(args);
    } catch (err) {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        (last as (e: unknown) => void)(err);
        return undefined;
      }
      return Promise.reject(err);
    }
    return original(...args);
  };
}

/**
 * Wrap a `pg.Pool` so every parameterised query — via `pool.query(...)` or via
 * a `pool.connect()` client (transactions) — rejects NUL-bearing parameters.
 * Idempotent: returns the same pool, guarded at most once. Call once at pool
 * construction. Query-only test doubles are guarded at `query(...)` and left
 * otherwise unchanged.
 */
export function installNulGuard(pool: pg.Pool): pg.Pool {
  if (isGuarded(pool)) return pool;
  guardQueryable(pool as unknown as Queryable);

  const connect = (pool as unknown as { connect?: unknown }).connect;
  if (typeof connect !== 'function') return pool;

  const originalConnect = connect.bind(pool) as (cb?: unknown) => unknown;
  (pool as unknown as { connect: unknown }).connect = (cb?: unknown): unknown => {
    if (typeof cb === 'function') {
      return originalConnect((err: unknown, client: pg.PoolClient | undefined, release: unknown) => {
        if (client) guardQueryable(client as unknown as Queryable);
        (cb as (e: unknown, c: unknown, r: unknown) => void)(err, client, release);
      });
    }
    return (originalConnect() as Promise<pg.PoolClient>).then((client) => {
      guardQueryable(client as unknown as Queryable);
      return client;
    });
  };
  return pool;
}
