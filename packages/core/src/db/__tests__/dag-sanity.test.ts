/**
 * Migration DAG contract: SQL-only files, contiguous numeric slots, and immutable
 * shipped names/bytes. The two already-shipped 0002 migrations are grandfathered;
 * renumbering either would break existing databases. The base comparison uses
 * the monorepo path and checks working-tree bytes as well as committed changes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from './phase2-cutover-helpers.js';

const MIGRATION_FILE_REGEX = /^(\d+)_[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.sql$/;

interface ParsedMigration {
  readonly file: string;
  readonly prefix: number;
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => MIGRATION_FILE_REGEX.test(entry))
    .sort();
}

function parseMigrationFiles(files: ReadonlyArray<string>): ParsedMigration[] {
  return files.map((file) => {
    const match = MIGRATION_FILE_REGEX.exec(file);
    if (!match) {
      throw new Error(`parseMigrationFiles: ${file} does not match the convention`);
    }
    return { file, prefix: Number.parseInt(match[1], 10) };
  });
}

describe('Phase 2 — migration file DAG (monotonic)', () => {
  it('migrations directory exists at src/db/migrations/', () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  it('every entry in the migrations directory matches <NNNN>_<name>.sql', () => {
    const entries = readdirSync(MIGRATIONS_DIR);
    const offending = entries.filter((entry) => !MIGRATION_FILE_REGEX.test(entry));
    expect(offending).toEqual([]);
  });

  it('has no duplicate numeric prefix beyond the shipped 0002 pair', () => {
    const parsed = parseMigrationFiles(listMigrationFiles());
    const prefixes = parsed.map((entry) => entry.prefix);
    const duplicates = parsed.filter((entry, index) => prefixes.indexOf(entry.prefix) !== index);
    // Both 0002 names shipped before this guard; renumbering either breaks upgrades.
    expect(duplicates.map((entry) => entry.file)).toEqual(['0002_memories_external_id_index.sql']);
  });

  it('prefixes are strictly increasing with no gaps starting at 1', () => {
    const parsed = [...new Map(parseMigrationFiles(listMigrationFiles()).map((entry) => [entry.prefix, entry])).values()];
    expect(parsed.length).toBeGreaterThan(0);
    for (let i = 0; i < parsed.length; i += 1) {
      expect(parsed[i].prefix).toBe(i + 1);
    }
  });

  it('includes the frozen 0001_baseline.sql at the head of the sequence', () => {
    const files = listMigrationFiles();
    expect(files[0]).toBe('0001_baseline.sql');
  });
});

/** Public migrations are immutable once present on the base branch. */
const MIGRATIONS_PATH = 'packages/core/src/db/migrations';
const REPO_ROOT = resolve(MIGRATIONS_DIR, '../../../../..');

describe('Phase 2 — migration file DAG (no-rewrite vs base branch)', () => {
  it('preserves every shipped migration name and its bytes', () => {
    const base = resolveBaseBranch();
    if (!base) throw new Error('Migration no-rewrite check requires origin/main or main');
    const files = git(['ls-tree', '-r', '--name-only', base, '--', MIGRATIONS_PATH])
      .trim().split('\n').filter((file) => /\/\d{4}_[^/]+\.sql$/.test(file));
    expect(files.length, 'The base path must resolve real migration files').toBeGreaterThan(0);
    for (const file of files) {
      const path = resolve(REPO_ROOT, file);
      expect(existsSync(path), `Shipped migration removed or renamed: ${file}`).toBe(true);
      expect(readFileSync(path, 'utf8'), `Shipped migration changed: ${file}`)
        .toBe(git(['show', `${base}:${file}`]));
    }
  });
});

function resolveBaseBranch(): string | null {
  for (const candidate of ['origin/main', 'main']) {
    const probe = spawnSync('git', ['rev-parse', '--verify', candidate], {
      cwd: REPO_ROOT, encoding: 'utf-8',
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`Migration history check failed: ${result.stderr}`);
  return result.stdout;
}
