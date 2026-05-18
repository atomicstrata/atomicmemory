/**
 * @file Neutral test-only `pg.Pool` proxies used by service AND route
 * tests to exercise post-put DB-failure recovery branches.
 *
 * Lives outside any subsystem-specific test directory so route tests
 * don't need to import from `services/__tests__/`. Each wrapper
 * intercepts the `recordUploadedArtifact` UPDATE (the post-put CAS
 * that flips `pending` → `stored`) and either fails, commits-then-
 * throws, or returns a clean CAS miss — passing every other query
 * through to the real pool unchanged.
 */

import type pg from 'pg';

const POST_PUT_UPDATE_MARKER = "SET status = 'stored'";
const TABLE_MARKER = 'UPDATE storage_artifacts';

function isPostPutUpdate(text: string): boolean {
  return text.includes(POST_PUT_UPDATE_MARKER) && text.includes(TABLE_MARKER);
}

function queryText(sql: string | { text: string }): string {
  return typeof sql === 'string' ? sql : sql.text;
}

/**
 * Shared internal: install a proxy whose `query` intercepts the next
 * `count` post-put UPDATEs with `preempt`, then passes everything
 * else through. Used by the two pre-empt-style wrappers below so
 * their bodies don't share token-for-token duplicated control flow.
 */
function wrapPoolPreEmptingPostPut(
  realPool: pg.Pool,
  count: number,
  preempt: () => Promise<unknown>,
): pg.Pool {
  let remaining = count;
  const proxy = Object.create(realPool) as pg.Pool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proxy as any).query = (sql: string | { text: string }, params?: unknown[]) => {
    if (remaining > 0 && isPostPutUpdate(queryText(sql))) {
      remaining--;
      return preempt();
    }
    return realPool.query(sql as never, params as never);
  };
  return proxy;
}

/**
 * Throw `Error('forced post-put UPDATE failure')` the first
 * `failCount` times `recordUploadedArtifact` runs its UPDATE, then
 * pass through. Used to exercise the recovery + cleanup branches.
 */
export function wrapPoolFailingRecord(realPool: pg.Pool, failCount: number): pg.Pool {
  return wrapPoolPreEmptingPostPut(realPool, failCount, () =>
    Promise.reject(new Error('forced post-put UPDATE failure')),
  );
}

/**
 * Let the UPDATE actually commit (real pool dispatch), then throw
 * `throwsRemaining` times. Simulates "network blip after commit"
 * so the service's commit-after-throw reconciliation can be
 * exercised without leaving the row in a half-finalized state.
 */
export function wrapPoolCommitThenThrow(realPool: pg.Pool, throwsRemaining: number): pg.Pool {
  let remaining = throwsRemaining;
  const proxy = Object.create(realPool) as pg.Pool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proxy as any).query = async (sql: string | { text: string }, params?: unknown[]) => {
    const text = queryText(sql);
    const result = await realPool.query(sql as never, params as never);
    if (remaining > 0 && isPostPutUpdate(text)) {
      remaining--;
      throw new Error('simulated commit-then-throw');
    }
    return result;
  };
  return proxy;
}

/**
 * Resolve the UPDATE with `{ rowCount: 0, rows: [] }` (clean CAS
 * miss) `missCount` times without throwing. Lets the recovery
 * branch surface the typed CAS-miss Error rather than `undefined`.
 */
export function wrapPoolCasMiss(realPool: pg.Pool, missCount: number): pg.Pool {
  return wrapPoolPreEmptingPostPut(realPool, missCount, () =>
    Promise.resolve({ rowCount: 0, rows: [] } as never),
  );
}
