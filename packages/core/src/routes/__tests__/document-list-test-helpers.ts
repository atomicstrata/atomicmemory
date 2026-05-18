/**
 * Shared helpers for the Phase D document-list / recovery route
 * test files. Centralises the verbatim `registerDoc`, cursor-encoder,
 * `REGISTER_BASE`, layer-status seeder, and per-suite fetch/cursor
 * assertion helpers that `document-list-root-route.test.ts` and
 * `document-without-memories-route.test.ts` would otherwise duplicate
 * line-for-line, so fallow's clone detector stays clean.
 */

import { expect } from 'vitest';
import type pg from 'pg';

/**
 * Required register-body fields shared across every Phase D list /
 * recovery test. Tests spread this in and override `user_id` and
 * `external_id` per-call.
 */
export const REGISTER_BASE = { source_site: 'drive', provider: 'google-drive' } as const;

/**
 * Wire-shape projection both Phase D list endpoints return on the
 * happy path. `extraction_status` is included so tests can assert
 * forward-compat values like `'running'` directly on the wire row.
 */
export interface PhaseDListBody {
  documents: { id: string; user_id: string; extraction_status: string }[];
  next_cursor: string | null;
}

/**
 * Hit `POST /v1/documents` against the supplied test base URL and
 * return the freshly-registered document id. Mirrors the production
 * register call exactly; tests use it as a `setup` helper rather
 * than as a behavior assertion.
 */
export async function registerDoc(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

/**
 * Build a structurally valid cursor payload (base64url-encoded JSON
 * with the right key shape) so the test can land inside
 * `decodeListCursor`'s validation branches rather than its outer
 * base64 / JSON parse guards. Used for the "structurally valid but
 * semantically invalid" cursor cases on both list endpoints.
 */
export function base64urlEncodeJson(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Union shape every Phase-D list response collapses to from a test's
 * point of view: either a typed list body or the documented
 * `{ error: string }` 400 envelope.
 */
export type ListBodyOrError<TBody> = TBody | { error: string };

/**
 * Build a `(query) => fetch + parse` helper bound to a specific
 * Phase-D list path. Used by the two list-route test suites to
 * share the URL construction + JSON parse boilerplate without
 * exposing the fetch wrapper at every call site. Both `baseUrl` and
 * `path` flow through unchanged so the per-suite typings on `TBody`
 * still describe the wire shape that suite expects.
 */
export function createListFetcher<TBody>(
  getBaseUrl: () => string,
  path: string,
): (query: Record<string, string>) => Promise<{
  status: number;
  body: ListBodyOrError<TBody>;
}> {
  return async (query) => {
    const params = new URLSearchParams(query);
    const res = await fetch(`${getBaseUrl()}${path}?${params}`);
    return {
      status: res.status,
      body: (await res.json()) as ListBodyOrError<TBody>,
    };
  };
}

/**
 * Force one or more Phase B per-layer status columns on a `raw_documents`
 * row via a direct DB UPDATE. Mirrors what the service-owned
 * constrained transitions land, but bypasses them for setup-only
 * tests. Caller supplies any subset of (`extraction_status`,
 * `semantic_index_status`, `raw_storage_status`); omitted fields are
 * left alone.
 */
export async function seedLayerStatus(
  pool: pg.Pool,
  documentId: string,
  fields: {
    extraction_status?: string;
    semantic_index_status?: string;
    raw_storage_status?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [documentId];
  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return;
  await pool.query(`UPDATE raw_documents SET ${sets.join(', ')} WHERE id = $1`, params);
}

/**
 * Send a cursor-bearing request against a Phase-D list route and
 * assert the route returns `400 invalid_cursor`. Used by the
 * negative-cursor sub-tests where the only variable is the payload
 * that should fail decoding.
 */
export async function expectInvalidCursor<TBody>(
  listFn: (query: Record<string, string>) => Promise<{
    status: number;
    body: ListBodyOrError<TBody>;
  }>,
  userId: string,
  cursor: string,
): Promise<void> {
  const { status, body } = await listFn({ user_id: userId, cursor });
  expect(status).toBe(400);
  expect((body as { error: string }).error).toBe('invalid_cursor');
}
