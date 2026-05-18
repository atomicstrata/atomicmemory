/**
 * Phase 8.5 — shared test utilities for Filecoin observability
 * integration tests. Hoisted out of the individual test files so
 * fallow stops flagging the spy/capture pattern as a clone across
 * `document-upload-observability.test.ts` and
 * `raw-storage-reconciler-observability.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, vi, type MockInstance } from 'vitest';
import { pool } from '../../db/pool.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import {
  clearDocumentTables,
  setupTestSchema,
} from '../../db/__tests__/test-fixtures.js';

export interface FilecoinEventLine {
  event: string;
  detail: Record<string, unknown>;
}

export interface CapturedEvents {
  events: FilecoinEventLine[];
  restore: () => void;
}

/**
 * Spy on `console.log` and capture every `[FILECOIN] {...}` line as
 * a parsed event. The non-matching log lines are dropped (the test
 * never asserts against them). Callers MUST call `restore()` in a
 * `finally` so subsequent tests start clean.
 */
export function captureFilecoinEvents(): CapturedEvents {
  const events: FilecoinEventLine[] = [];
  const spy: MockInstance = vi
    .spyOn(console, 'log')
    .mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (typeof first !== 'string' || !first.startsWith('[FILECOIN] ')) return;
      events.push(
        JSON.parse(first.slice('[FILECOIN] '.length)) as FilecoinEventLine,
      );
    });
  return { events, restore: () => spy.mockRestore() };
}

/** Convenience: first matching event by name, or `undefined`. */
export function findFilecoinEvent(
  events: ReadonlyArray<FilecoinEventLine>,
  name: string,
): FilecoinEventLine | undefined {
  return events.find((e) => e.event === name);
}

/**
 * Register a pointer-only raw document for the supplied user and
 * return its id. Mirrors the inline `seedDoc` pattern several test
 * files duplicated before Phase 8.5; lives here so observability
 * tests don't need to re-implement the upsert + register dance.
 */
export async function registerEmptyDocument(
  userId: string,
  externalId: string,
): Promise<string> {
  const src = await upsertRawSource(pool, {
    userId,
    sourceSite: 'drive',
    provider: 'drive',
  });
  const reg = await registerRawDocument(pool, {
    userId,
    rawSourceId: src.id,
    externalId,
  });
  return reg.document.id;
}

/**
 * Standard Postgres-backed test lifecycle:
 *   beforeAll → setupTestSchema(pool)
 *   afterAll  → clearDocumentTables(pool) + pool.end()
 *   beforeEach → clearDocumentTables(pool)
 *
 * Called once at the top of an observability test file. Centralises
 * the lifecycle so the standard idiom doesn't multiply across new
 * test files; pre-existing repo tests still inline the pattern (out
 * of scope for Phase 8.5 to refactor).
 */
export function useDocumentTestLifecycle(): void {
  beforeAll(async () => {
    await setupTestSchema(pool);
  });
  afterAll(async () => {
    await clearDocumentTables(pool);
    await pool.end();
  });
  beforeEach(async () => {
    await clearDocumentTables(pool);
  });
}
