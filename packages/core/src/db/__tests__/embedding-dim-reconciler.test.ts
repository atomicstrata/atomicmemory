/**
 * Integration tests for the embedding-dimension reconciler.
 *
 * Verifies the documented behaviors against a real Postgres+pgvector
 * instance for *any* fixed-dimension pgvector column, not just columns
 * named `embedding`:
 *   1. No-op when the configured dimension already matches.
 *   2. ALTER + recreate indexes when the column is empty (covers both
 *      `embedding` and `summary_embedding`).
 *   3. Throw EmbeddingDimensionMismatch when the column holds vectors.
 *
 * Tests run inside a dedicated schema (with `public` second in
 * search_path so pgvector's `vector` type remains reachable) so they
 * cannot collide with the production schema set up by `setupTestSchema`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../pool.js';
import {
  type AlteredVectorColumn,
  EmbeddingDimensionMismatch,
  reconcileEmbeddingDimension,
  type ReconcileResult,
} from '../reconcilers.js';
import {
  readVectorColumnDimension,
  registerReconcilerSchemaLifecycle,
} from './reconciler-test-helpers.js';

const TEST_SCHEMA = 'reconciler_test_schema';
const TABLE_A = 'reconciler_table_a';
const TABLE_B = 'reconciler_table_b';
const TABLE_MULTI = 'reconciler_table_multi';

async function indexNamesFor(table: string): Promise<string[]> {
  const { rows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
    [TEST_SCHEMA, table],
  );
  return rows.map((row) => row.indexname);
}

function expectNoAlteration(result: ReconcileResult): void {
  expect(result.reconciled).toBe(false);
  expect(result.alteredColumns).toEqual([]);
}

function expectAlteredColumns(
  result: ReconcileResult,
  columns: AlteredVectorColumn[],
): void {
  expect(result.reconciled).toBe(true);
  expect(result.alteredColumns).toEqual(columns);
}

async function expectColumnDimension(
  table: string,
  column: string,
  dimension: number,
): Promise<void> {
  expect(await readVectorColumnDimension(pool, TEST_SCHEMA, table, column)).toBe(
    dimension,
  );
}

async function catchMismatch(
  requiredDimension: number,
): Promise<EmbeddingDimensionMismatch> {
  try {
    await reconcileEmbeddingDimension(pool, requiredDimension);
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingDimensionMismatch);
    return err as EmbeddingDimensionMismatch;
  }
  throw new Error('Expected EmbeddingDimensionMismatch');
}

function expectMismatchFields(
  error: EmbeddingDimensionMismatch,
  columnName: string,
): void {
  expect(error.tableName).toBe(TABLE_A);
  expect(error.columnName).toBe(columnName);
  expect(error.currentDimension).toBe(4);
  expect(error.requiredDimension).toBe(8);
  expect(error.rowCount).toBe(1);
  expect(error.message).toContain(columnName);
}

describe('reconcileEmbeddingDimension', () => {
  registerReconcilerSchemaLifecycle({
    afterAll,
    beforeAll,
    beforeEach,
    pool,
    schema: TEST_SCHEMA,
  });

  it('is a no-op when every vector column already matches', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, embedding vector(8))`,
    );
    const result = await reconcileEmbeddingDimension(pool, 8);
    expectNoAlteration(result);
    await expectColumnDimension(TABLE_A, 'embedding', 8);
  });

  it('returns no-op when no vector columns exist in current schema', async () => {
    const result = await reconcileEmbeddingDimension(pool, 16);
    expectNoAlteration(result);
  });

  it('alters an empty `embedding` column with a mismatched dimension', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, embedding vector(4))`,
    );
    const result = await reconcileEmbeddingDimension(pool, 8);
    expectAlteredColumns(result, [
      { tableName: TABLE_A, columnName: 'embedding' },
    ]);
    await expectColumnDimension(TABLE_A, 'embedding', 8);
  });

  it('alters an empty `summary_embedding` column with a mismatched dimension', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, summary_embedding vector(4))`,
    );
    const result = await reconcileEmbeddingDimension(pool, 16);
    expectAlteredColumns(result, [
      { tableName: TABLE_A, columnName: 'summary_embedding' },
    ]);
    await expectColumnDimension(TABLE_A, 'summary_embedding', 16);
  });

  it('drops and recreates HNSW indexes on a non-`embedding` vector column', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, summary_embedding vector(4))`,
    );
    const indexName = `${TABLE_A}_summary_hnsw_idx`;
    await pool.query(
      `CREATE INDEX ${indexName} ON ${TABLE_A}
         USING hnsw (summary_embedding vector_cosine_ops)`,
    );
    expect(await indexNamesFor(TABLE_A)).toContain(indexName);

    const result = await reconcileEmbeddingDimension(pool, 32);
    expectAlteredColumns(result, [
      { tableName: TABLE_A, columnName: 'summary_embedding' },
    ]);
    await expectColumnDimension(TABLE_A, 'summary_embedding', 32);
    expect(await indexNamesFor(TABLE_A)).toContain(indexName);
  });

  it('alters multiple vector columns on the same table independently', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_MULTI} (
         id serial PRIMARY KEY,
         embedding vector(4),
         topic_embedding vector(4)
       )`,
    );
    const result = await reconcileEmbeddingDimension(pool, 8);
    expectAlteredColumns(result, [
      { tableName: TABLE_MULTI, columnName: 'embedding' },
      { tableName: TABLE_MULTI, columnName: 'topic_embedding' },
    ]);
    await expectColumnDimension(TABLE_MULTI, 'embedding', 8);
    await expectColumnDimension(TABLE_MULTI, 'topic_embedding', 8);
  });

  it('throws EmbeddingDimensionMismatch when an `embedding` column holds vectors', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, embedding vector(4))`,
    );
    await pool.query(
      `INSERT INTO ${TABLE_A} (embedding) VALUES ('[1,2,3,4]'::vector)`,
    );

    const e = await catchMismatch(8);
    expectMismatchFields(e, 'embedding');
    expect(e.message).toContain(TABLE_A);
    expect(e.message).toContain('vector(4)');
    await expectColumnDimension(TABLE_A, 'embedding', 4);
  });

  it('throws EmbeddingDimensionMismatch when a `summary_embedding` column holds vectors', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, summary_embedding vector(4))`,
    );
    await pool.query(
      `INSERT INTO ${TABLE_A} (summary_embedding) VALUES ('[1,2,3,4]'::vector)`,
    );

    const e = await catchMismatch(8);
    expectMismatchFields(e, 'summary_embedding');
    await expectColumnDimension(TABLE_A, 'summary_embedding', 4);
  });

  it('ignores rows with NULL vectors when counting population', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, summary_embedding vector(4) NULL)`,
    );
    await pool.query(`INSERT INTO ${TABLE_A} (summary_embedding) VALUES (NULL)`);
    const result = await reconcileEmbeddingDimension(pool, 8);
    expectAlteredColumns(result, [
      { tableName: TABLE_A, columnName: 'summary_embedding' },
    ]);
    await expectColumnDimension(TABLE_A, 'summary_embedding', 8);
  });

  it('discovers multiple tables with differently-named vector columns', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, embedding vector(4))`,
    );
    await pool.query(
      `CREATE TABLE ${TABLE_B} (id serial PRIMARY KEY, recap_embedding vector(4))`,
    );
    const result = await reconcileEmbeddingDimension(pool, 8);
    expectAlteredColumns(result, [
      { tableName: TABLE_A, columnName: 'embedding' },
      { tableName: TABLE_B, columnName: 'recap_embedding' },
    ]);
    await expectColumnDimension(TABLE_A, 'embedding', 8);
    await expectColumnDimension(TABLE_B, 'recap_embedding', 8);
  });

  it('leaves unconstrained `vector` columns (typmod -1) alone', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_A} (id serial PRIMARY KEY, embedding vector)`,
    );
    const result = await reconcileEmbeddingDimension(pool, 8);
    expectNoAlteration(result);
  });

  it('rejects invalid required dimension', async () => {
    await expect(reconcileEmbeddingDimension(pool, 0)).rejects.toThrow(
      /positive integer/,
    );
    await expect(reconcileEmbeddingDimension(pool, -1)).rejects.toThrow(
      /positive integer/,
    );
    await expect(reconcileEmbeddingDimension(pool, 1.5)).rejects.toThrow(
      /positive integer/,
    );
  });
});
