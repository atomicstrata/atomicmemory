/**
 * Static verification of the TBC Phase 3 baseline migration additions.
 * Asserts the SQL contains the expected DDL without requiring a DB connection.
 */

import { describe, it, expect } from 'vitest';
import {
  BASELINE_SQL as schemaSql,
  CHECK_CONSTRAINT_REWRITE,
  IDEMPOTENT_DDL,
} from './baseline-sql-fixture.js';

describe('TBC Phase 3 schema additions', () => {
  it('adds confidence column to memories with default 1.0 and [0,1] check', () => {
    expect(schemaSql).toMatch(
      /ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 1\.0/,
    );
    expect(schemaSql).toMatch(/CHECK \(confidence >= 0\.0 AND confidence <= 1\.0\)/);
  });

  it('adds belief_tier column with the four allowed values', () => {
    expect(schemaSql).toMatch(
      /ALTER TABLE memories ADD COLUMN IF NOT EXISTS belief_tier TEXT DEFAULT 'standard'/,
    );
    expect(schemaSql).toMatch(/'standard'.*'directive'.*'demoted'.*'retracted'/s);
  });

  it('adds mutation_type column with the eight TBC operators', () => {
    expect(schemaSql).toMatch(
      /ALTER TABLE memories ADD COLUMN IF NOT EXISTS mutation_type TEXT DEFAULT NULL/,
    );
    for (const op of [
      'AFFIRM',
      'UPDATE',
      'RETRACT',
      'SUPERSEDE',
      'PROMOTE',
      'DEMOTE',
      'EVIDENCE_FOR',
      'COUNTER',
    ]) {
      expect(schemaSql).toContain(`'${op}'`);
    }
  });

  it('creates idx_memories_belief_tier (partial index, excludes standard)', () => {
    expect(schemaSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_memories_belief_tier[\s\S]*belief_tier != 'standard'/,
    );
  });

  it('creates idx_memories_confidence (DESC for high-confidence-first retrieval)', () => {
    expect(schemaSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_memories_confidence[\s\S]*confidence DESC/,
    );
  });

  it('creates belief_edges table with the five edge types', () => {
    expect(schemaSql).toMatch(/CREATE TABLE IF NOT EXISTS belief_edges/);
    for (const edge of ['evidence_for', 'counter', 'supersedes', 'promotes', 'demotes']) {
      expect(schemaSql).toContain(`'${edge}'`);
    }
  });

  it('belief_edges weight is bounded [-1.0, 1.0]', () => {
    expect(schemaSql).toMatch(/weight >= -1\.0 AND weight <= 1\.0/);
  });

  it('belief_edges has workspace + agent columns for multi-tenant scoping', () => {
    const beliefEdgesBlock = schemaSql.match(/CREATE TABLE IF NOT EXISTS belief_edges[\s\S]*?\);/);
    expect(beliefEdgesBlock).not.toBeNull();
    expect(beliefEdgesBlock?.[0]).toContain('workspace_id UUID DEFAULT NULL');
    expect(beliefEdgesBlock?.[0]).toContain('agent_id UUID DEFAULT NULL');
  });

  it('creates the three belief_edges indexes for traversal patterns', () => {
    expect(schemaSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_belief_edges_target/);
    expect(schemaSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_belief_edges_source/);
    expect(schemaSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_belief_edges_user_target/);
  });

  it('all Phase 3 additions are idempotent (CREATE/ALTER IF NOT EXISTS)', () => {
    const phase3Section = schemaSql.split(/-- TBC Phase 3/)[1];
    expect(phase3Section).toBeDefined();
    // Constraint rewrites are also idempotent when they use DROP CONSTRAINT IF EXISTS.
    const ddlStatements = phase3Section.match(/^(ALTER TABLE|CREATE TABLE|CREATE INDEX)\b[^;]*;/gm) ?? [];
    expect(ddlStatements.length).toBeGreaterThan(0);
    for (const stmt of ddlStatements) {
      expect(IDEMPOTENT_DDL.test(stmt) || CHECK_CONSTRAINT_REWRITE.test(stmt)).toBe(true);
    }
  });

  it('Phase 3 section header is present and dated', () => {
    expect(schemaSql).toMatch(/-- TBC Phase 3 \(2026-05-06\): Typed Belief Calculus/);
  });
});
