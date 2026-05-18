/**
 * Deterministic seed data for the Phase 1 migration tests.
 *
 * Inserts exactly one representative row per core-owned table that the
 * Phase 1 data-preservation contract names. Every row uses a fixed UUID
 * so pre/post-migration snapshots compare exactly, and every FK lines up
 * so the post-migration FK-resolution check has something to verify.
 *
 * The seeded table list is hard-coded against the pinned v1.0.2 schema
 * (src/db/__tests__/fixtures/legacy-schema.sql). All listed tables exist
 * in that fixture — they MUST all be present. Any missing table is a
 * fixture regression and the seeder fails loudly with the table name.
 *
 * Phase 1 plan: docs/ops/db/phase-1-production-harden.md.
 */

import pg from 'pg';
import {
  seedVector,
  vectorLiteral,
  snapshotTable,
  tableExists,
  type TableSnapshot,
} from './migration-test-helpers.js';
import { config } from '../../config.js';

const SEED_USER_ID = 'phase1-preservation-user';
const SEED_SOURCE_SITE = 'phase1-preservation-site';

export interface SeedIds {
  readonly episodeId: string;
  readonly canonicalId: string;
  readonly memoryId: string;
  readonly claimId: string;
  readonly claimVersionId: string;
  readonly evidenceId: string;
  readonly entityId: string;
  readonly rawSourceId: string;
  readonly rawDocumentId: string;
  readonly documentChunkId: string;
  readonly storageArtifactId: string;
}

const IDS = {
  episode: '11111111-1111-4111-8111-111111111111',
  canonical: '22222222-2222-4222-8222-222222222222',
  memory: '33333333-3333-4333-8333-333333333333',
  claim: '44444444-4444-4444-8444-444444444444',
  claimVersion: '55555555-5555-4555-8555-555555555555',
  evidence: '66666666-6666-4666-8666-666666666666',
  entity: '77777777-7777-4777-8777-777777777777',
  rawSource: '88888888-8888-4888-8888-888888888888',
  rawDocument: '99999999-9999-4999-8999-999999999999',
  documentChunk: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  storageArtifact: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;

/**
 * Insert exactly one representative row per core-owned table.
 *
 * Every table named below is required by the pinned v1.0.2 fixture.
 * Missing-table check runs up front: if any table is absent, the seeder
 * throws with the table name. The data-preservation contract is a guard
 * against silent loss — it must not adapt around a degraded fixture.
 */
export async function seedLegacyFixtureData(pool: pg.Pool): Promise<SeedIds> {
  await assertAllSeedTablesPresent(pool);

  const dims = config.embeddingDimensions;
  const memoryEmbedding = vectorLiteral(seedVector(1, dims));
  const claimVersionEmbedding = vectorLiteral(seedVector(2, dims));
  const entityEmbedding = vectorLiteral(seedVector(3, dims));

  await insertEpisode(pool);
  await insertCanonical(pool);
  await insertMemory(pool, memoryEmbedding);
  await insertClaim(pool);
  await insertClaimVersion(pool, claimVersionEmbedding);
  await insertEvidence(pool);
  await insertEntity(pool, entityEmbedding);
  await insertMemoryEntity(pool);
  await insertRawSource(pool);
  await insertRawDocument(pool);
  await insertDocumentChunk(pool, memoryEmbedding);
  await insertStorageArtifact(pool);

  return {
    episodeId: IDS.episode,
    canonicalId: IDS.canonical,
    memoryId: IDS.memory,
    claimId: IDS.claim,
    claimVersionId: IDS.claimVersion,
    evidenceId: IDS.evidence,
    entityId: IDS.entity,
    rawSourceId: IDS.rawSource,
    rawDocumentId: IDS.rawDocument,
    documentChunkId: IDS.documentChunk,
    storageArtifactId: IDS.storageArtifact,
  };
}

async function assertAllSeedTablesPresent(pool: pg.Pool): Promise<void> {
  for (const { table } of SEEDED_TABLE_PRIMARY_KEYS) {
    if (!(await tableExists(pool, table))) {
      throw new Error(
        `Phase 1 seed fixture missing required legacy table: ${table}. ` +
          `Check src/db/__tests__/fixtures/legacy-schema.sql against the pinned v1.0.2 baseline.`,
      );
    }
  }
}

async function insertEpisode(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO episodes (id, user_id, content, source_site, source_url, session_id, created_at)
     VALUES ($1, $2, 'phase1 episode body', $3, 'https://example.test/ep', 'phase1-session',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.episode, SEED_USER_ID, SEED_SOURCE_SITE],
  );
}

async function insertCanonical(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO canonical_memory_objects
       (id, user_id, object_family, payload_format, canonical_payload, provenance,
        observed_at, lineage, created_at)
     VALUES ($1, $2, 'ingested_fact', 'json',
             '{"text": "user prefers dark mode"}'::jsonb,
             '{"source": "phase1-test"}'::jsonb,
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             '{}'::jsonb,
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.canonical, SEED_USER_ID],
  );
}

async function insertMemory(pool: pg.Pool, embedding: string): Promise<void> {
  await pool.query(
    `INSERT INTO memories
       (id, user_id, content, embedding, memory_type, importance, source_site, source_url,
        episode_id, status, metadata, keywords, summary, overview, trust_score,
        observed_at, created_at, last_accessed_at, access_count, network)
     VALUES ($1, $2, 'phase1 memory content', $3::vector,
             'semantic', 0.75, $4, 'https://example.test/m',
             $5, 'active', '{"k": "v"}'::jsonb, 'phase1 keywords',
             'summary text', 'overview text', 0.9,
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             0, 'experience')`,
    [IDS.memory, SEED_USER_ID, embedding, SEED_SOURCE_SITE, IDS.episode],
  );
}

async function insertClaim(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO memory_claims
       (id, user_id, claim_type, status, slot_key, valid_at, created_at, updated_at)
     VALUES ($1, $2, 'fact', 'active', 'phase1-slot',
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.claim, SEED_USER_ID],
  );
}

async function insertClaimVersion(pool: pg.Pool, embedding: string): Promise<void> {
  await pool.query(
    `INSERT INTO memory_claim_versions
       (id, claim_id, user_id, memory_id, content, embedding, importance, source_site,
        source_url, episode_id, valid_from, created_at)
     VALUES ($1, $2, $3, $4, 'phase1 claim text', $5::vector, 0.6, $6,
             'https://example.test/cv', $7,
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [
      IDS.claimVersion,
      IDS.claim,
      SEED_USER_ID,
      IDS.memory,
      embedding,
      SEED_SOURCE_SITE,
      IDS.episode,
    ],
  );
  await pool.query(`UPDATE memory_claims SET current_version_id = $1 WHERE id = $2`, [
    IDS.claimVersion,
    IDS.claim,
  ]);
}

async function insertEvidence(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO memory_evidence
       (id, claim_version_id, episode_id, memory_id, quote_text, speaker, created_at)
     VALUES ($1, $2, $3, $4, 'phase1 evidence quote', 'user',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.evidence, IDS.claimVersion, IDS.episode, IDS.memory],
  );
}

async function insertEntity(pool: pg.Pool, embedding: string): Promise<void> {
  await pool.query(
    `INSERT INTO entities
       (id, user_id, name, normalized_name, entity_type, embedding, alias_names,
        normalized_alias_names, created_at, updated_at)
     VALUES ($1, $2, 'Phase 1 Entity', 'phase 1 entity', 'project', $3::vector,
             ARRAY['P1 alias']::TEXT[], ARRAY['p1 alias']::TEXT[],
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.entity, SEED_USER_ID, embedding],
  );
}

async function insertMemoryEntity(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO memory_entities (memory_id, entity_id, created_at)
     VALUES ($1, $2, TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.memory, IDS.entity],
  );
}

async function insertRawSource(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO raw_sources
       (id, user_id, source_site, provider, account_id, storage_mode,
        retention_policy, consent_policy, created_at, updated_at)
     VALUES ($1, $2, $3, 'phase1-provider', 'acct-1', 'pointer_only',
             '{"days": 30}'::jsonb, '{"granted": true}'::jsonb,
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.rawSource, SEED_USER_ID, SEED_SOURCE_SITE],
  );
}

async function insertRawDocument(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO raw_documents
       (id, user_id, raw_source_id, external_id, external_uri, display_name, mime_type,
        size_bytes, content_hash, provider_version, storage_mode,
        registration_status, raw_storage_status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, 'phase1-doc-1', 'https://example.test/doc',
             'phase1.txt', 'text/plain', 1024, 'sha256:phase1', 'v1',
             'pointer_only', 'registered', 'pointer_recorded',
             '{"label": "phase1"}'::jsonb,
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.rawDocument, SEED_USER_ID, IDS.rawSource],
  );
}

async function insertDocumentChunk(pool: pg.Pool, embedding: string): Promise<void> {
  await pool.query(
    `INSERT INTO document_chunks
       (id, user_id, raw_document_id, chunk_index, content, content_hash,
        char_start, char_end, token_count, embedding,
        parser_version, chunker_version, metadata, created_at)
     VALUES ($1, $2, $3, 0, 'phase1 chunk body', 'sha256:phase1-chunk',
             0, 17, 4, $4::vector,
             'phase2-text-v1', 'phase2-fixed-v1', '{}'::jsonb,
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.documentChunk, SEED_USER_ID, IDS.rawDocument, embedding],
  );
}

async function insertStorageArtifact(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO storage_artifacts
       (id, user_id, provider, mode, uri, status, size_bytes, content_type,
        content_encoding, disclose_content_hash, identifiers, lifecycle,
        metadata, created_at, updated_at)
     VALUES ($1, $2, 'phase1-provider', 'pointer',
             'https://example.test/artifact', 'stored', 1024, 'text/plain',
             'identity', false,
             '{"k": "v"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             TIMESTAMPTZ '2026-05-01 00:00:00Z',
             TIMESTAMPTZ '2026-05-01 00:00:00Z')`,
    [IDS.storageArtifact, SEED_USER_ID],
  );
}

/**
 * Foreign-key audit queries. Each entry returns true if the relationship is
 * still resolvable; the data-preservation test asserts they are all true after
 * migrate() so an accidental rewrite/reinsert is caught.
 */
export interface ForeignKeyAudit {
  readonly memoryEpisodeMatches: boolean;
  readonly claimVersionClaimMatches: boolean;
  readonly claimVersionMemoryMatches: boolean;
  readonly evidenceClaimVersionMatches: boolean;
  readonly memoryEntityMemoryMatches: boolean;
  readonly memoryEntityEntityMatches: boolean;
  readonly rawDocumentSourceMatches: boolean;
  readonly documentChunkDocumentMatches: boolean;
}

export async function auditForeignKeys(pool: pg.Pool, ids: SeedIds): Promise<ForeignKeyAudit> {
  return {
    memoryEpisodeMatches: await rowExists(
      pool,
      `SELECT 1 FROM memories WHERE id = $1 AND episode_id = $2`,
      [ids.memoryId, ids.episodeId],
    ),
    claimVersionClaimMatches: await rowExists(
      pool,
      `SELECT 1 FROM memory_claim_versions cv JOIN memory_claims c ON c.id = cv.claim_id
        WHERE cv.id = $1 AND c.id = $2`,
      [ids.claimVersionId, ids.claimId],
    ),
    claimVersionMemoryMatches: await rowExists(
      pool,
      `SELECT 1 FROM memory_claim_versions WHERE id = $1 AND memory_id = $2`,
      [ids.claimVersionId, ids.memoryId],
    ),
    evidenceClaimVersionMatches: await rowExists(
      pool,
      `SELECT 1 FROM memory_evidence WHERE id = $1 AND claim_version_id = $2`,
      [ids.evidenceId, ids.claimVersionId],
    ),
    memoryEntityMemoryMatches: await rowExists(
      pool,
      `SELECT 1 FROM memory_entities WHERE memory_id = $1 AND entity_id = $2`,
      [ids.memoryId, ids.entityId],
    ),
    memoryEntityEntityMatches: await rowExists(
      pool,
      `SELECT 1 FROM memory_entities me JOIN entities e ON e.id = me.entity_id
        WHERE me.entity_id = $1 AND e.id = $2`,
      [ids.entityId, ids.entityId],
    ),
    rawDocumentSourceMatches: await rowExists(
      pool,
      `SELECT 1 FROM raw_documents rd JOIN raw_sources rs ON rs.id = rd.raw_source_id
        WHERE rd.id = $1 AND rs.id = $2`,
      [ids.rawDocumentId, ids.rawSourceId],
    ),
    documentChunkDocumentMatches: await rowExists(
      pool,
      `SELECT 1 FROM document_chunks dc JOIN raw_documents rd ON rd.id = dc.raw_document_id
        WHERE dc.id = $1 AND rd.id = $2`,
      [ids.documentChunkId, ids.rawDocumentId],
    ),
  };
}

async function rowExists(pool: pg.Pool, sql: string, params: ReadonlyArray<unknown>): Promise<boolean> {
  const { rowCount } = await pool.query(sql, params as unknown[]);
  return (rowCount ?? 0) > 0;
}

/**
 * Snapshot every seeded table for a pre/post-migration deep-equal check.
 * Every table in SEEDED_TABLE_PRIMARY_KEYS MUST exist — silent skips would
 * defeat the data-preservation guard, so a missing table throws with the
 * table name.
 */
export async function snapshotAllSeededTables(
  pool: pg.Pool,
): Promise<Record<string, TableSnapshot>> {
  const result: Record<string, TableSnapshot> = {};
  for (const { table, primaryKey } of SEEDED_TABLE_PRIMARY_KEYS) {
    if (!(await tableExists(pool, table))) {
      throw new Error(
        `Phase 1 snapshot expected legacy table ${table} but it was not present. ` +
          `This must not be silently skipped — check the pinned v1.0.2 fixture.`,
      );
    }
    result[table] = await snapshotTable(pool, table, primaryKey);
  }
  return result;
}

/**
 * Ordered list of (table, primary key columns) covering everything the seeder
 * inserts. Used by snapshot helpers to keep snapshot ordering canonical.
 */
export const SEEDED_TABLE_PRIMARY_KEYS: ReadonlyArray<{ table: string; primaryKey: ReadonlyArray<string> }> = [
  { table: 'episodes', primaryKey: ['id'] },
  { table: 'canonical_memory_objects', primaryKey: ['id'] },
  { table: 'memories', primaryKey: ['id'] },
  { table: 'memory_claims', primaryKey: ['id'] },
  { table: 'memory_claim_versions', primaryKey: ['id'] },
  { table: 'memory_evidence', primaryKey: ['id'] },
  { table: 'entities', primaryKey: ['id'] },
  { table: 'memory_entities', primaryKey: ['memory_id', 'entity_id'] },
  { table: 'raw_sources', primaryKey: ['id'] },
  { table: 'raw_documents', primaryKey: ['id'] },
  { table: 'document_chunks', primaryKey: ['id'] },
  { table: 'storage_artifacts', primaryKey: ['id'] },
];
