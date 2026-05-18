#!/usr/bin/env tsx
/**
 * @file Build-time migrations hash manifest generator.
 *
 * Walks `dist/db/migrations/` (populated by `npm run build` immediately
 * before this script), reads each `.sql` file in lexical order, and writes
 * a stable manifest enumerating both the per-file digests and an aggregate
 * digest. Phase 2 ships a directory of frozen migration files instead of
 * a single `schema.sql`, so the manifest now describes that directory
 * rather than a single file.
 *
 * **Aggregate hash shape (audit-tightened):** `schemaSha256` is the
 * SHA-256 of a canonical `<filename>\t<per-file-sha256>\n` manifest text,
 * lexically ordered. Filename identity participates in the aggregate so a
 * future rename or reordering cannot accidentally collide with the
 * pre-rename hash even when the underlying SQL bytes are unchanged. The
 * runtime's `migration-schema.ts:buildAppliedSql()` computes the same
 * canonical text and the same digest; the build manifest and the runtime
 * fingerprint are kept in lockstep.
 *
 * **Fail-closed policy:** Phase 2 only ships SQL migration files. This
 * script throws when `dist/db/migrations/` is missing, contains zero
 * `.sql` files, lacks the frozen `0001_baseline.sql`, or contains any
 * empty `.sql` file. A misbuilt package that previously would have
 * shipped an empty manifest now fails the build instead.
 *
 * The manifest is intentionally metadata-only (no timestamps or machine
 * info) so identical migration bytes always produce identical package
 * output.
 *
 * Run via `npm run build`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface MigrationFileEntry {
  filename: string;
  sha256: string;
  bytes: number;
}

interface MigrationsManifest {
  migrationsPath: 'db/migrations';
  /** SHA-256 of the canonical "<filename>\t<sha256>\n" manifest text. */
  schemaSha256: string;
  files: MigrationFileEntry[];
}

const DIST_MIGRATIONS_DIR = 'dist/db/migrations';
const MANIFEST_PATH = 'dist/db/schema-sha256.json';
const BASELINE_FILENAME = '0001_baseline.sql';

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function listMigrationFilenames(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `[generate-schema-hash] migrations directory is missing at ${dir}. ` +
        `Build must copy src/db/migrations/*.sql into dist/db/migrations/ before this script runs.`,
      { cause: err as Error },
    );
  }
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();
  if (sqlFiles.length === 0) {
    throw new Error(
      `[generate-schema-hash] migrations directory ${dir} contains zero .sql files. ` +
        `Phase 2 packages MUST ship at least ${BASELINE_FILENAME}.`,
    );
  }
  if (!sqlFiles.includes(BASELINE_FILENAME)) {
    throw new Error(
      `[generate-schema-hash] frozen baseline ${BASELINE_FILENAME} is missing from ${dir}. ` +
        `The Phase 2 cutover contract requires it in every shipped build.`,
    );
  }
  return sqlFiles;
}

function buildFileEntry(absoluteDir: string, filename: string): MigrationFileEntry {
  const bytes = readFileSync(join(absoluteDir, filename));
  if (bytes.byteLength === 0) {
    throw new Error(
      `[generate-schema-hash] migration file ${filename} in ${absoluteDir} is empty. ` +
        `Refusing to write a manifest that would stamp the SHA without applying any DDL.`,
    );
  }
  return {
    filename,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
}

/**
 * Canonical, deterministic text whose sha256 is the aggregate `schemaSha256`.
 * One line per file, lexically ordered, `<filename>\t<sha256>\n`. Filename
 * participates so a rename cannot silently keep the old digest.
 */
function canonicalManifestText(files: ReadonlyArray<MigrationFileEntry>): string {
  return files.map((entry) => `${entry.filename}\t${entry.sha256}\n`).join('');
}

function buildManifest(absoluteDir: string): MigrationsManifest {
  const filenames = listMigrationFilenames(absoluteDir);
  const files = filenames.map((name) => buildFileEntry(absoluteDir, name));
  return {
    migrationsPath: 'db/migrations',
    schemaSha256: sha256Hex(canonicalManifestText(files)),
    files,
  };
}

function writeManifest(manifest: MigrationsManifest): void {
  const outputPath = resolve(MANIFEST_PATH);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function generateSchemaHash(): void {
  const absoluteDir = resolve(DIST_MIGRATIONS_DIR);
  // statSync up front so the error message points at the directory we tried,
  // not at the first readdirSync inside listMigrationFilenames (which already
  // throws with a clear message — this is just defense in depth for `dist/`).
  try {
    statSync(absoluteDir);
  } catch (err) {
    throw new Error(
      `[generate-schema-hash] expected ${absoluteDir} to exist (created by the build step).`,
      { cause: err as Error },
    );
  }
  const manifest = buildManifest(absoluteDir);
  writeManifest(manifest);
  console.log(
    `Wrote ${resolve(MANIFEST_PATH)} (` +
      `${manifest.files.length} migration file(s), ` +
      `aggregate sha=${manifest.schemaSha256.slice(0, 12)}…)`,
  );
}

generateSchemaHash();
