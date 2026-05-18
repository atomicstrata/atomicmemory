/**
 * Static verification of the Hierarchical Retrieval baseline migration
 * additions. Asserts DDL presence + idempotency without a DB connection.
 */

import { describe, it, expect } from 'vitest';
import {
  BASELINE_SQL as schemaSql,
  CHECK_CONSTRAINT_REWRITE,
  IDEMPOTENT_DDL,
} from './baseline-sql-fixture.js';

/**
 * Assert that the baseline SQL declares `CREATE TABLE IF NOT EXISTS <name>`
 * and that the captured table block contains every required column
 * fragment. Substrings (not regexes) so callers can paste DDL verbatim.
 */
function expectCreateTableContainsColumns(tableName: string, columnFragments: string[]): void {
  const tablePattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}`);
  expect(schemaSql).toMatch(tablePattern);
  const block = schemaSql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}[\\s\\S]*?\\);`));
  expect(block).not.toBeNull();
  const text = block?.[0] ?? '';
  for (const col of columnFragments) {
    expect(text).toContain(col);
  }
}

describe('Hierarchical Retrieval schema additions', () => {
  it('declares the dated section header', () => {
    expect(schemaSql).toMatch(/-- Hierarchical Retrieval \(2026-05-07\)/);
  });

  it('creates session_summaries table with the required columns', () => {
    expectCreateTableContainsColumns('session_summaries', [
      'session_id TEXT NOT NULL',
      'conversation_id TEXT NOT NULL',
      'session_index INTEGER NOT NULL',
      'summary_text TEXT NOT NULL',
      'summary_embedding vector(',
      'topics TEXT[]',
      'fact_count INTEGER',
      'occurred_start TIMESTAMPTZ',
      'occurred_end TIMESTAMPTZ',
      'workspace_id UUID',
      'agent_id UUID',
    ]);
  });

  it('creates conv_summaries table with the required columns', () => {
    expectCreateTableContainsColumns('conv_summaries', [
      'conversation_id TEXT NOT NULL',
      'summary_text TEXT NOT NULL',
      'summary_embedding vector(',
      'session_count INTEGER',
      'fact_count INTEGER',
      'workspace_id UUID',
      'agent_id UUID',
    ]);
  });

  it('creates HNSW indexes on both summary embeddings (cosine ops)', () => {
    expect(schemaSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_session_summaries_embedding[\s\S]*?USING hnsw \(summary_embedding vector_cosine_ops\)/,
    );
    expect(schemaSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_conv_summaries_embedding[\s\S]*?USING hnsw \(summary_embedding vector_cosine_ops\)/,
    );
  });

  it('creates user-scoped lookup indexes for both tables', () => {
    expect(schemaSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_session_summaries_user_conv/);
    expect(schemaSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_conv_summaries_user/);
  });

  it('all hierarchical additions are idempotent (CREATE/ALTER IF NOT EXISTS)', () => {
    const section = schemaSql.split(/-- Hierarchical Retrieval/)[1];
    expect(section).toBeDefined();
    const ddl = section.match(/^(ALTER TABLE|CREATE TABLE|CREATE INDEX)\b[^;]*;/gm) ?? [];
    expect(ddl.length).toBeGreaterThan(0);
    for (const stmt of ddl) {
      expect(IDEMPOTENT_DDL.test(stmt) || CHECK_CONSTRAINT_REWRITE.test(stmt)).toBe(true);
    }
  });

  it('freezes baseline vector dimensions before runtime reconciliation', () => {
    const sessSummariesBlock = schemaSql.match(/CREATE TABLE IF NOT EXISTS session_summaries[\s\S]*?\);/)?.[0] ?? '';
    const convSummariesBlock = schemaSql.match(/CREATE TABLE IF NOT EXISTS conv_summaries[\s\S]*?\);/)?.[0] ?? '';
    expect(sessSummariesBlock).toContain('vector(768)');
    expect(convSummariesBlock).toContain('vector(768)');
  });
});
