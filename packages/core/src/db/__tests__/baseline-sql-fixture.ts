/**
 * Shared loader for the frozen baseline migration SQL. Used by static
 * verification tests that grep for DDL clauses without opening a DB
 * connection.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const BASELINE_SQL: string = readFileSync(
  resolve(__dirname, '..', 'migrations', '0001_baseline.sql'),
  'utf-8',
);

/** Idempotent-DDL clauses the baseline must use throughout. */
export const IDEMPOTENT_DDL = /IF NOT EXISTS|DROP CONSTRAINT IF EXISTS/;

/** raw_documents CHECK-constraint rewrite shape used by Phase 3 additions. */
export const CHECK_CONSTRAINT_REWRITE = /ADD CONSTRAINT raw_documents_[a-z_]+_check/;
