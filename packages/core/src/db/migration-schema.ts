/**
 * Schema-file operations for the Phase 2 migration runner.
 *
 * Phase 2 replaces `schema.sql` with a directory of versioned migration files
 * under `src/db/migrations/` (frozen `0001_baseline.sql` + dated successors).
 * This module enumerates those files, reads them, and computes the package's
 * canonical schema fingerprint.
 *
 * **Fingerprint shape (audit-tightened):** the package SHA is no longer the
 * SHA-256 of the raw concatenated SQL bytes. It is the SHA-256 of an ordered
 * `<filename>\t<per-file-sha256>\n` manifest, computed across every shipped
 * `.sql` migration in lexical order. Filename identity participates in the
 * hash so a future rename or reorder cannot collide with the old digest even
 * if the underlying SQL bytes happen to be equal. The manifest text is
 * canonicalized (deterministic separators, no JSON whitespace dependency) so
 * identical shipped bytes always produce identical digests across PG/Node
 * versions and CI runners.
 *
 * **Fail-closed policy:** Phase 2 only ships SQL migration files. The list
 * helper throws when the migrations directory is missing, when it contains
 * no `.sql` files, when the frozen baseline (`0001_baseline.sql`) is absent,
 * or when any shipped `.sql` file is empty. Earlier versions of this module
 * silently tolerated these states, which let a misbuilt package stamp a DB
 * with an empty schema; that is now a build/runtime error.
 *
 * Kept as a separate module so the side-effect-free transformations can be
 * unit-tested without a database, and so the migration runner stays focused
 * on coordination + persistence rather than file shape.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Matches every HNSW pgvector index `CREATE INDEX` statement in the shipped
 * migrations, regardless of whether the indexed column is literally
 * `embedding` or a topic / summary / recap variant. Anchored on the
 * `USING hnsw (<column> vector_cosine_ops)` clause that is uniform across
 * all such indexes; the `[^;]*?` segments forbid crossing a `;` so we cannot
 * accidentally swallow neighbouring statements. Trailing newline / blank
 * line consumption keeps the post-strip SQL tidy.
 */
const VECTOR_INDEX_REGEX =
  /CREATE INDEX(?:\s+IF NOT EXISTS)?[^;]*?USING hnsw\s*\([a-z_]+\s+vector_cosine_ops\)[^;]*;(?:\n\n?|$)/g;

/**
 * Directory containing the package's migration files. Resolves identically
 * at dev (`src/db/migrations`) and dist (`dist/db/migrations`) because the
 * build step copies the directory verbatim alongside the compiled JS.
 */
export const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

/**
 * Filename of the frozen baseline migration. Its presence is part of the
 * package's invariant: every shipped build MUST contain this file, because
 * the Phase 2 cutover stamps it as already-applied on pre-Phase-2 upgrades
 * (see `migration-api.ts:stampBaselineAsApplied`). A build without it is
 * unshippable and is rejected at list time.
 */
const BASELINE_MIGRATION_FILENAME = '0001_baseline.sql';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Return the package's shipped migration filenames in lexical order. Used
 * both by the runtime (to drive the migration framework) and by tests.
 *
 * Fails closed when the directory is missing, contains zero `.sql` files,
 * is missing the frozen baseline, or contains an empty `.sql` file. Any of
 * those states means the package is misbuilt (or the working tree is in
 * the middle of a half-finished edit) and continuing would risk stamping
 * a database without ever creating the schema.
 */
export function listMigrationFilenames(): string[] {
  const filenames = readSqlFilenamesOrThrow(MIGRATIONS_DIR);
  assertBaselinePresent(filenames);
  assertNoEmptyFiles(MIGRATIONS_DIR, filenames);
  return filenames;
}

function readSqlFilenamesOrThrow(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `[migration-schema] migrations directory is missing at ${dir}. ` +
        `Phase 2 packages must ship src/db/migrations/0001_baseline.sql.`,
      { cause: err as Error },
    );
  }
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();
  if (sqlFiles.length === 0) {
    throw new Error(
      `[migration-schema] migrations directory at ${dir} contains zero .sql files. ` +
        `Phase 2 packages must ship at least src/db/migrations/0001_baseline.sql.`,
    );
  }
  return sqlFiles;
}

function assertBaselinePresent(filenames: ReadonlyArray<string>): void {
  if (!filenames.includes(BASELINE_MIGRATION_FILENAME)) {
    throw new Error(
      `[migration-schema] frozen baseline ${BASELINE_MIGRATION_FILENAME} is missing ` +
        `from ${MIGRATIONS_DIR}. The Phase 2 cutover contract requires it to ` +
        `be present in every shipped build.`,
    );
  }
}

function assertNoEmptyFiles(dir: string, filenames: ReadonlyArray<string>): void {
  for (const name of filenames) {
    const { size } = statSync(join(dir, name));
    if (size === 0) {
      throw new Error(
        `[migration-schema] migration file ${name} in ${dir} is empty. ` +
          `An empty file would stamp the package SHA without applying any DDL.`,
      );
    }
  }
}

function readMigrationFile(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf-8');
}

function maybeStripVectorIndexes(sql: string, strip: boolean): string {
  return strip ? sql.replace(VECTOR_INDEX_REGEX, '') : sql;
}

/**
 * Per-file entry in the canonical manifest. Filename ordering is preserved
 * by `listMigrationFilenames()`; each entry's `sha256` is computed over the
 * post-strip SQL bytes (i.e., `skipVectorIndexes` participates in the hash
 * so test runs against pgvector-less Postgres deterministically diverge
 * from production runs).
 */
interface MigrationManifestEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Build an ordered manifest of {filename, per-file sha256, byte length} for
 * every shipped `.sql` migration. Used by both the runtime fingerprint and
 * the build-time `scripts/generate-schema-hash.ts` manifest writer so the
 * two stay in lockstep.
 */
function buildMigrationManifest(
  skipVectorIndexes: boolean = false,
): MigrationManifestEntry[] {
  return listMigrationFilenames().map((filename) => {
    const sql = maybeStripVectorIndexes(readMigrationFile(filename), skipVectorIndexes);
    return {
      filename,
      sha256: sha256Hex(sql),
      bytes: Buffer.byteLength(sql, 'utf8'),
    };
  });
}

/**
 * Canonical text whose SHA-256 is the package's aggregate schema fingerprint.
 * Format is one line per shipped migration, in lexical order:
 *
 *     <filename>\t<sha256>\n
 *
 * Filename identity participates so a rename cannot collide with the
 * pre-rename digest even when the underlying SQL bytes are identical. No
 * JSON, no trailing whitespace, no platform-dependent line endings — the
 * function is intentionally restrictive so the same shipped bytes always
 * produce the same digest across runners.
 */
export function buildMigrationManifestText(skipVectorIndexes: boolean = false): string {
  return buildMigrationManifest(skipVectorIndexes)
    .map((entry) => `${entry.filename}\t${entry.sha256}\n`)
    .join('');
}

/**
 * Returns the canonical hash-input text for the package's currently-shipped
 * migration set. Both `migrate()` and `migrationStatus()` feed this through
 * `sha256Hex()` to compute the `schema_sha256` value stamped into
 * `schema_version` (and the value compared against the DB-recorded stamp).
 *
 * NOTE: despite the historical name, this function no longer returns raw
 * concatenated SQL bytes; the audit found that hashing raw bytes lost
 * filename/order identity, so the contract was tightened to "hash the
 * manifest of {filename, per-file sha256}". The function name is preserved
 * for call-site source compatibility (see `migration-api.ts`,
 * `migration-status.ts`); the bytes returned are the manifest text from
 * `buildMigrationManifestText()`.
 *
 * `embeddingDimensions` is accepted for API parity with Phase 1 but is
 * ignored: the Phase 1 `{{EMBEDDING_DIMENSIONS}}` template was eliminated
 * when `0001_baseline.sql` was frozen with a literal default, so the
 * manifest is stable across `embeddingDimensions` values. The runtime
 * reconciler adjusts column dimensions post-migrate.
 */
export function buildAppliedSql(
  embeddingDimensions: number,
  skipVectorIndexes: boolean,
): string {
  void embeddingDimensions;
  return buildMigrationManifestText(skipVectorIndexes);
}

export function readPackageVersion(): string {
  // dist/db/migration-schema.js → ../../package.json
  // src/db/migration-schema.ts  → ../../package.json
  const packageJsonPath = resolve(__dirname, '..', '..', 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  if (!parsed.version) {
    throw new Error('[migration-schema] package.json is missing "version"');
  }
  return parsed.version;
}

/**
 * Build the `notes` column captured alongside every `schema_version` row.
 * Records non-default configuration choices that materially affect what
 * bytes were applied, so a history grep is enough to reconstruct intent.
 */
export function buildSchemaNotes(opts: {
  skipVectorIndexes: boolean;
  embeddingDimensions: number;
}): string {
  const parts: string[] = [];
  if (opts.skipVectorIndexes) parts.push('skipVectorIndexes=true');
  parts.push(`embeddingDimensions=${opts.embeddingDimensions}`);
  return parts.join(',');
}
