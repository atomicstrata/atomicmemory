/**
 * Embedding-dimension reconciler for @atomicmemory/core migrations.
 *
 * Discovers every pgvector column in the current schema with a fixed
 * (positive-typmod) dimension and either alters it to the configured
 * embedding dimension (when the column has no data yet) or throws a
 * descriptive error so the operator must resolve the conflict deliberately.
 *
 * The discovery surface is intentionally column-name agnostic: the baseline
 * migration defines several config-driven vector columns whose names vary
 * (e.g. `embedding`, `summary_embedding`, `topic_embedding`,
 * `recap_embedding`). The whole surface must move together when the
 * embedding model changes, so the reconciler treats every fixed-dimension
 * pgvector column as in-scope rather than hard-coding either table or column
 * names.
 *
 * Designed to be invoked by `migrate()` after framework migrations have run
 * (or after we confirm a peer replica already ran them).
 *
 * See docs/db/migrations.md for where this runs in the migration sequence.
 */

import pg from 'pg';

/**
 * Either a pool or an already-checked-out client. The reconciler will check
 * out its own client from a pool when it needs a transaction; if the caller
 * is already operating on a client (e.g., the connection that holds the
 * advisory migration lock) it can pass that client directly.
 */
export type ReconcilerExecutor = pg.Pool | pg.PoolClient;

export interface AlteredVectorColumn {
  tableName: string;
  columnName: string;
}

export interface ReconcileResult {
  /** True if at least one vector column was altered. */
  reconciled: boolean;
  /** (table, column) pairs whose vector type was altered. */
  alteredColumns: AlteredVectorColumn[];
}

interface VectorColumn {
  tableName: string;
  columnName: string;
  currentDimension: number;
}

interface SavedIndex {
  indexName: string;
  createStmt: string;
}

/**
 * Thrown when a fixed-dimension pgvector column has non-null vectors and
 * its declared dimension does not match the configured embedding
 * dimension. Reconciliation refuses to alter populated columns because
 * doing so would silently invalidate every stored vector.
 *
 * `tableName`, `currentDimension`, `requiredDimension`, and `rowCount` are
 * preserved from the Phase 1 design; `columnName` is added so callers can
 * disambiguate between e.g. `memories.embedding` and `memories.topic_embedding`.
 */
export class EmbeddingDimensionMismatch extends Error {
  constructor(
    public readonly tableName: string,
    public readonly currentDimension: number,
    public readonly requiredDimension: number,
    public readonly rowCount: number,
    public readonly columnName: string = 'embedding',
  ) {
    super(
      `Embedding dimension mismatch on column "${tableName}"."${columnName}": ` +
        `column is vector(${currentDimension}) but the configured embedding ` +
        `dimension is ${requiredDimension}, and the column holds ${rowCount} ` +
        `row(s) with a non-null vector. The reconciler refuses to alter a ` +
        `populated vector column. To resolve, either:\n` +
        `  1. DELETE FROM "${tableName}" (or scope-wipe rows so "${columnName}" ` +
        `is empty), then re-run migrate() so the column can be altered safely; or\n` +
        `  2. Switch the embedding model back to one producing ` +
        `${currentDimension}-dimensional vectors so the existing rows remain valid.`,
    );
    this.name = 'EmbeddingDimensionMismatch';
  }
}

/**
 * Discover every fixed-dimension pgvector column in the current schema.
 *
 * Filters to regular tables (relkind='r'), skips dropped attributes, and
 * requires `atttypmod > 0` so unconstrained `vector` columns (which carry
 * no dimension contract) are left alone. No column-name filter is applied:
 * `embedding`, `summary_embedding`, `topic_embedding`, and any future
 * config-driven vector column are all in scope.
 */
async function discoverVectorColumns(
  executor: ReconcilerExecutor,
): Promise<VectorColumn[]> {
  const { rows } = await executor.query<{
    table_name: string;
    column_name: string;
    current_dimension: number;
  }>(
    `SELECT
       c.relname    AS table_name,
       a.attname    AS column_name,
       a.atttypmod  AS current_dimension
     FROM pg_attribute a
     JOIN pg_class     c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     JOIN pg_type      t ON a.atttypid = t.oid
     WHERE n.nspname = current_schema()
       AND t.typname = 'vector'
       AND a.atttypmod > 0
       AND NOT a.attisdropped
       AND c.relkind = 'r'
     ORDER BY c.relname, a.attname`,
  );
  return rows.map((row) => ({
    tableName: row.table_name,
    columnName: row.column_name,
    currentDimension: row.current_dimension,
  }));
}

/** Count rows with a non-null value in the given column. */
async function countNonNullVectors(
  executor: ReconcilerExecutor,
  tableName: string,
  columnName: string,
): Promise<number> {
  const quotedTable = pg.escapeIdentifier(tableName);
  const quotedColumn = pg.escapeIdentifier(columnName);
  const { rows } = await executor.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`,
  );
  return Number.parseInt(rows[0].count, 10);
}

/**
 * Find indexes whose first indexed column is `columnName` on `tableName`.
 * pgvector indexes (HNSW, IVFFlat) are single-column on the vector field,
 * so the first-column check correctly identifies the indexes that must be
 * dropped before `ALTER COLUMN ... TYPE vector(N)`. Returns each index's
 * name plus the CREATE statement we can replay verbatim afterwards.
 */
async function findColumnIndexes(
  executor: ReconcilerExecutor,
  tableName: string,
  columnName: string,
): Promise<SavedIndex[]> {
  const { rows } = await executor.query<{
    index_name: string;
    create_stmt: string;
  }>(
    `SELECT
       i.relname                       AS index_name,
       pg_get_indexdef(idx.indexrelid) AS create_stmt
     FROM pg_index idx
     JOIN pg_class     i ON idx.indexrelid = i.oid
     JOIN pg_class     c ON idx.indrelid   = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = idx.indkey[0]
     WHERE c.relname = $1
       AND n.nspname = current_schema()
       AND a.attname = $2`,
    [tableName, columnName],
  );
  return rows.map((row) => ({
    indexName: row.index_name,
    createStmt: row.create_stmt,
  }));
}

/**
 * Drop the indexes on (tableName, columnName), alter the column type, then
 * recreate the indexes. All wrapped in a single transaction so the column
 * is never left half-altered.
 */
async function alterVectorColumn(
  client: pg.PoolClient,
  tableName: string,
  columnName: string,
  requiredDimension: number,
): Promise<void> {
  const quotedTable = pg.escapeIdentifier(tableName);
  const quotedColumn = pg.escapeIdentifier(columnName);
  const indexes = await findColumnIndexes(client, tableName, columnName);
  await client.query('BEGIN');
  try {
    for (const idx of indexes) {
      await client.query(`DROP INDEX ${pg.escapeIdentifier(idx.indexName)}`);
    }
    await client.query(
      `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedColumn} TYPE vector(${requiredDimension})`,
    );
    for (const idx of indexes) {
      await client.query(idx.createStmt);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * True when the executor is a pg.Pool (i.e., we must check out a client).
 *
 * Detects Pool vs. PoolClient by the presence of `.release` rather than the
 * presence of `.connect`. Both pg.Pool and pg.PoolClient expose `.connect`,
 * so a `.connect`-only probe misidentifies an already-checked-out PoolClient
 * as a Pool and then "reconnects" it — which is what migrate() does when it
 * hands its locked PoolClient to reconcileEmbeddingDimension(). Only Pool
 * lacks `.release`, so the negative check is the safe discriminator.
 */
function isPool(executor: ReconcilerExecutor): executor is pg.Pool {
  if (typeof (executor as pg.Pool).connect !== 'function') return false;
  return typeof (executor as { release?: unknown }).release !== 'function';
}

async function withClient<T>(
  executor: ReconcilerExecutor,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPool(executor)) return fn(executor as pg.PoolClient);
  const client = await executor.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Reconcile the dimension of every fixed-dimension pgvector column in the
 * current schema with `requiredDimension`.
 *
 * - Matches: no-op.
 * - Mismatch + non-null rows: throws `EmbeddingDimensionMismatch`.
 * - Mismatch + empty: drops indexes on the column, alters its type, recreates indexes.
 */
export async function reconcileEmbeddingDimension(
  executor: ReconcilerExecutor,
  requiredDimension: number,
): Promise<ReconcileResult> {
  if (!Number.isInteger(requiredDimension) || requiredDimension <= 0) {
    throw new Error(
      `reconcileEmbeddingDimension: requiredDimension must be a positive ` +
        `integer, got ${requiredDimension}`,
    );
  }
  const columns = await discoverVectorColumns(executor);
  const alteredColumns: AlteredVectorColumn[] = [];
  for (const { tableName, columnName, currentDimension } of columns) {
    if (currentDimension === requiredDimension) continue;
    const rowCount = await countNonNullVectors(executor, tableName, columnName);
    if (rowCount > 0) {
      throw new EmbeddingDimensionMismatch(
        tableName,
        currentDimension,
        requiredDimension,
        rowCount,
        columnName,
      );
    }
    await withClient(executor, (client) =>
      alterVectorColumn(client, tableName, columnName, requiredDimension),
    );
    alteredColumns.push({ tableName, columnName });
  }
  return { reconciled: alteredColumns.length > 0, alteredColumns };
}
