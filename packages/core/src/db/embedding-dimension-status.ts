/**
 * Read-only pgvector dimension inspection for migrationStatus().
 *
 * The reconciler mutates empty vector columns to the configured dimension.
 * This module performs only catalog reads so operators can see drift before
 * a later write path or migrate() call fails.
 */

import type { Pool, PoolClient } from 'pg';

export type EmbeddingDimensionStatusValue =
  | 'not_applicable'
  | 'matches'
  | 'mismatch'
  | 'missing_vector_columns';

export interface EmbeddingDimensionMismatchSummary {
  readonly tableName: string;
  readonly columnName: string;
  readonly currentDimension: number;
  readonly requiredDimension: number;
}

export interface EmbeddingDimensionStatus {
  readonly requiredDimension: number;
  readonly status: EmbeddingDimensionStatusValue;
  readonly vectorColumnCount: number;
  readonly mismatches: readonly EmbeddingDimensionMismatchSummary[];
}

export function noSchemaEmbeddingStatus(
  requiredDimension: number,
): EmbeddingDimensionStatus {
  return {
    requiredDimension,
    status: 'not_applicable',
    vectorColumnCount: 0,
    mismatches: [],
  };
}

export async function inspectEmbeddingDimensionStatus(
  client: Pick<Pool | PoolClient, 'query'>,
  requiredDimension: number,
): Promise<EmbeddingDimensionStatus> {
  const columns = await readVectorColumns(client);
  const mismatches = columns
    .filter((column) => column.currentDimension !== requiredDimension)
    .map((column) => ({ ...column, requiredDimension }));
  return {
    requiredDimension,
    status: statusFor(columns.length, mismatches.length),
    vectorColumnCount: columns.length,
    mismatches,
  };
}

interface VectorColumnDimension {
  readonly tableName: string;
  readonly columnName: string;
  readonly currentDimension: number;
}

async function readVectorColumns(
  client: Pick<Pool | PoolClient, 'query'>,
): Promise<VectorColumnDimension[]> {
  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
    current_dimension: number;
  }>(
    `SELECT
       c.relname AS table_name,
       a.attname AS column_name,
       a.atttypmod AS current_dimension
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     JOIN pg_type t ON a.atttypid = t.oid
     WHERE n.nspname = current_schema()
       AND c.relkind = 'r'
       AND t.typname = 'vector'
       AND a.atttypmod > 0
       AND NOT a.attisdropped
     ORDER BY c.relname, a.attname`,
  );
  return rows.map((row) => ({
    tableName: row.table_name,
    columnName: row.column_name,
    currentDimension: row.current_dimension,
  }));
}

function statusFor(
  vectorColumnCount: number,
  mismatchCount: number,
): EmbeddingDimensionStatusValue {
  if (vectorColumnCount === 0) return 'missing_vector_columns';
  return mismatchCount === 0 ? 'matches' : 'mismatch';
}
