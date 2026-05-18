/**
 * Shared mock `pg.Pool` for repository unit tests that assert SQL shape
 * without touching a live database. Returns the pool plus a `calls` log
 * the caller asserts against.
 */

import type pg from 'pg';

export interface QueryCall {
  text: string;
  values?: unknown[];
}

/**
 * Build a fake `pg.Pool` whose `query()` returns canned rows in order.
 * The Nth call returns `rowsByCall[N]` (or `[]` if not provided).
 */
export function makeMockPool(rowsByCall: Array<unknown[]>): { pool: pg.Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  let i = 0;
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const rows = rowsByCall[i] ?? [];
      i += 1;
      return { rows };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}
