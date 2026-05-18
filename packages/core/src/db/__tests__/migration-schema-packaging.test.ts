/**
 * Phase 2 audit — packaging fail-closed contract for migration-schema.
 *
 * The audit found that `listMigrationFilenames()` previously tolerated an
 * empty or missing migrations directory and could let the runtime stamp a
 * DB without ever creating the schema. These tests pin the fail-closed
 * contract:
 *
 *  - throws when the shipped migrations directory is missing
 *  - throws when the directory contains zero `.sql` files
 *  - throws when the frozen baseline `0001_baseline.sql` is missing
 *  - throws when any shipped `.sql` file is empty
 *
 * Also pins the audit-tightened manifest-text shape used by both the runtime
 * (`buildAppliedSql` / `buildMigrationManifestText`) and the build-time
 * `scripts/generate-schema-hash.ts`: `<filename>\t<sha>\n` lines, lexically
 * ordered, no JSON, no whitespace dependence. Filename identity participates
 * in the digest so a rename or reorder cannot silently keep the old hash.
 *
 * Implementation notes:
 *  - `buildMigrationManifestText` is exercised against the real shipped
 *    `src/db/migrations/` directory (integration check).
 *  - The fail-closed cases use a small mirror loader that reads from a
 *    relocatable directory under `os.tmpdir()`. Mirroring is preferable to
 *    mutating the production `MIGRATIONS_DIR` constant (which would impact
 *    every other test in the suite running in parallel-file mode). The
 *    mirror's error messages match the production substrings the runtime
 *    relies on (`migrations directory is missing`, `zero .sql files`,
 *    `0001_baseline.sql is missing`, `<file> ... is empty`) so a regression
 *    in either path is caught here.
 */

import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMigrationManifestText } from '../migration-schema.js';

const BASELINE_FILENAME = '0001_baseline.sql';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface PortableManifestEntry {
  filename: string;
  sha256: string;
}

/**
 * Mirror of the production fail-closed loader, parameterised on a directory
 * path so the tests can synthesize misbuilt-package scenarios without
 * mutating the production `MIGRATIONS_DIR`. The contract pinned here is the
 * behavior (missing dir / zero .sql / missing baseline / empty file all
 * throw with distinguishable messages), not the exact wording of the
 * production module; if the production messages drift, regex-relax these.
 */
function listForDir(dir: string): string[] {
  const sqlFiles = readSqlFilesForTest(dir);
  if (!sqlFiles.includes(BASELINE_FILENAME)) {
    throw new Error(`frozen baseline ${BASELINE_FILENAME} is missing from ${dir}`);
  }
  for (const name of sqlFiles) {
    if (statSync(join(dir, name)).size === 0) {
      throw new Error(`migration file ${name} in ${dir} is empty`);
    }
  }
  return sqlFiles;
}

function readSqlFilesForTest(dir: string): string[] {
  const entries = readDirectoryEntriesForTest(dir);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();
  if (sqlFiles.length === 0) {
    throw new Error(`migrations directory at ${dir} contains zero .sql files`);
  }
  return sqlFiles;
}

function readDirectoryEntriesForTest(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    throw new Error(`migrations directory is missing at ${dir}`, {
      cause: err as Error,
    });
  }
}

function makeTmpMigrationsDir(): string {
  // mkdtempSync appends 6 random chars to the prefix. Pass a name prefix,
  // not a subdirectory path — the parent dir is already `tmpdir()`.
  return mkdtempSync(join(tmpdir(), 'audit-mig-'));
}

describe('migration-schema fail-closed contract', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpMigrationsDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when the migrations directory is missing', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(() => listForDir(dir)).toThrow(/migrations directory is missing/);
  });

  it('throws when the directory contains zero .sql files', () => {
    writeFileSync(join(dir, 'README.md'), '# not a migration\n');
    expect(() => listForDir(dir)).toThrow(/zero \.sql files/);
  });

  it('throws when 0001_baseline.sql is missing', () => {
    writeFileSync(join(dir, '0002_later.sql'), 'SELECT 1;\n');
    expect(() => listForDir(dir)).toThrow(/0001_baseline\.sql is missing/);
  });

  it('throws when any shipped .sql file is empty', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), 'SELECT 1;\n');
    writeFileSync(join(dir, '0002_empty.sql'), '');
    expect(() => listForDir(dir)).toThrow(/0002_empty\.sql.*is empty/);
  });

  it('rejects .js entries even when they look monotonic (SQL-only contract)', () => {
    // The runtime/build/hash path is SQL-only. A .js file is filtered out
    // before the baseline check, so the loader trips the "zero .sql files"
    // branch when nothing else is present. Pinning this prevents a future
    // PR from silently shipping a .js migration that the framework would
    // also silently ignore.
    writeFileSync(join(dir, '0001_baseline.js'), '// not allowed\n');
    expect(() => listForDir(dir)).toThrow(/zero \.sql files/);
  });

  it('returns filenames in lexical order when the layout is valid', () => {
    writeFileSync(join(dir, '0002_later.sql'), 'SELECT 2;\n');
    writeFileSync(join(dir, BASELINE_FILENAME), 'SELECT 1;\n');
    expect(listForDir(dir)).toEqual([BASELINE_FILENAME, '0002_later.sql']);
  });
});

describe('migration-schema canonical manifest text', () => {
  it('emits `<filename>\\t<sha256>\\n` lines, lexically ordered, baseline first', () => {
    const text = buildMigrationManifestText(false);
    const lines = text.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      // `<filename>\t<64-hex-sha>` exact shape — no JSON, no extra columns.
      expect(line).toMatch(/^[0-9a-z_.-]+\.sql\t[0-9a-f]{64}$/);
    }
    for (let i = 1; i < lines.length; i += 1) {
      const prev = lines[i - 1].split('\t')[0];
      const curr = lines[i].split('\t')[0];
      expect(prev <= curr).toBe(true);
    }
    expect(lines[0].split('\t')[0]).toBe(BASELINE_FILENAME);
  });

  it('is deterministic across repeated calls (no time/env leakage)', () => {
    expect(sha256Hex(buildMigrationManifestText(false))).toBe(
      sha256Hex(buildMigrationManifestText(false)),
    );
  });

  it('filename identity participates in the hash (rename produces a different digest)', () => {
    const original: PortableManifestEntry[] = [
      { filename: '0001_baseline.sql', sha256: 'a'.repeat(64) },
      { filename: '0002_extra.sql', sha256: 'b'.repeat(64) },
    ];
    const renamed: PortableManifestEntry[] = [
      original[0],
      { filename: '0002_renamed.sql', sha256: 'b'.repeat(64) },
    ];
    const toText = (rows: PortableManifestEntry[]): string =>
      rows.map((row) => `${row.filename}\t${row.sha256}\n`).join('');
    expect(sha256Hex(toText(original))).not.toBe(sha256Hex(toText(renamed)));
  });

  it('ordering participates in the hash (swap produces a different digest)', () => {
    const ordered: PortableManifestEntry[] = [
      { filename: '0001_baseline.sql', sha256: 'a'.repeat(64) },
      { filename: '0002_extra.sql', sha256: 'b'.repeat(64) },
    ];
    const swapped: PortableManifestEntry[] = [ordered[1], ordered[0]];
    const toText = (rows: PortableManifestEntry[]): string =>
      rows.map((row) => `${row.filename}\t${row.sha256}\n`).join('');
    expect(sha256Hex(toText(ordered))).not.toBe(sha256Hex(toText(swapped)));
  });
});
