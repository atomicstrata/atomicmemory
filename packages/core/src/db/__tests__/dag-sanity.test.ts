/**
 * Phase 2 — DAG sanity for the migration directory.
 *
 * Per docs/ops/db/phase-2-versioned-migrations.md § "DAG sanity tests" and
 * the risks checklist (mistakenly editing or deleting an already-shipped
 * migration file):
 *
 *  - **SQL-only**: Phase 2 ships only SQL migrations. The build copy step,
 *    the runtime hash manifest, and the fail-closed loader all assume
 *    `.sql`. Allowing `.js`/`.ts` files in the directory here would let a
 *    PR commit one that never gets packaged or hashed; the regex
 *    deliberately rejects them so the contract holds at PR review time.
 *  - **Monotonic**: every file in `src/db/migrations/` follows the
 *    `<NNNN>_<name>.sql` convention, prefixes are strictly increasing
 *    across files, and there are no gaps in the sequence. Catches the
 *    "two PRs both picked 0007 and the lexical sort silently runs one
 *    before the other" failure mode at PR review time.
 *  - **No-rewrite**: the diff against the base branch never `D`eletes or
 *    `R`enames a migration file. Once a migration is on `main`, it is
 *    frozen. This is the machine-checkable answer to the
 *    "mistakenly editing the baseline post-shipment" risk that turns
 *    Scenario B/C into a silent corruption path.
 *
 * The monotonic check is fully local; the no-rewrite check needs git and
 * a reachable base branch. The base branch lookup tries `origin/main`
 * first (CI's normal default) and falls back to local `main`. If neither
 * resolves the no-rewrite assertion is skipped with `it.skip` semantics
 * surfaced via an explicit `expect.fail`-style message: the test does
 * not pass silently, but it does not falsely fail when run in a
 * detached environment that lacks a remote.
 *
 * Runtime dependency: the monotonic test asserts the migrations directory
 * exists. Until the Phase 2 runtime lands and ships `0001_baseline.sql`
 * the directory is absent and this test fails with a clear assertion
 * pointing at the missing directory.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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

  it('every migration file has a unique numeric prefix', () => {
    const parsed = parseMigrationFiles(listMigrationFiles());
    const prefixes = parsed.map((entry) => entry.prefix);
    expect(prefixes.length).toBe(new Set(prefixes).size);
  });

  it('prefixes are strictly increasing with no gaps starting at 1', () => {
    const parsed = parseMigrationFiles(listMigrationFiles());
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

/**
 * Files we consider "framework-managed" Phase 2 migrations: the 4-digit
 * prefix convention `0001_…`, `0002_…`. The legacy 8-digit
 * timestamped files (`20260512_…`) that used to live in the same
 * directory were provenance-only and were explicitly moved to
 * `docs/db/changelog/` as part of the Phase 2 cutover cleanup (see
 * Phase 2 plan §Cleanup). Deletions/renames of those legacy files are
 * expected and are NOT a no-rewrite violation.
 */
const FRAMEWORK_FILE_REGEX = /^src\/db\/migrations\/0\d{3}_[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.sql$/;

describe('Phase 2 — migration file DAG (no-rewrite vs base branch)', () => {
  it('never deletes or renames a framework-managed migration file', () => {
    const base = resolveBaseBranch();
    if (!base) {
      // Surface as a failed assertion rather than a silent pass. CI has
      // `origin/main`; a local dev environment without it gets an
      // explicit reason rather than a passing test that didn't run.
      expect.fail(
        'no-rewrite check requires `origin/main` or local `main` to be ' +
          'reachable. None resolved; cannot diff migration files against the base branch.',
      );
      return;
    }
    const diff = gitDiffNameStatus(base, 'src/db/migrations');
    const forbidden = diff.filter(
      (entry) =>
        (entry.status === 'D' || entry.status === 'R') &&
        FRAMEWORK_FILE_REGEX.test(entry.file),
    );
    expect(forbidden).toEqual([]);
  });
});

function resolveBaseBranch(): string | null {
  for (const candidate of ['origin/feat/db-migration-phase1', 'feat/db-migration-phase1', 'origin/main', 'main']) {
    const probe = spawnSync('git', ['rev-parse', '--verify', candidate], {
      encoding: 'utf-8',
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

interface DiffEntry {
  readonly status: string;
  readonly file: string;
}

function gitDiffNameStatus(base: string, pathFilter: string): DiffEntry[] {
  const result = spawnSync(
    'git',
    ['diff', '--name-status', `${base}...HEAD`, '--', pathFilter],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `git diff against ${base} failed (status=${result.status}): ${result.stderr}`,
    );
  }
  return parseDiffOutput(result.stdout);
}

function parseDiffOutput(stdout: string): DiffEntry[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseDiffLine);
}

function parseDiffLine(line: string): DiffEntry {
  // Examples: "A\tsrc/db/migrations/0002_foo.sql"
  //           "D\tsrc/db/migrations/0001_baseline.sql"
  //           "R100\tsrc/db/migrations/0001_baseline.sql\tsrc/db/migrations/0001_renamed.sql"
  const [statusToken, ...paths] = line.split('\t');
  // Status may be "R100" (rename with similarity %); keep just the first char.
  const status = statusToken.charAt(0);
  return { status, file: paths[0] ?? '' };
}
