/**
 * Write-side queries for episodes and active memory projections.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import {
  type CanonicalFactPayload,
  type CanonicalMemoryObjectFamily,
  type CanonicalMemoryObjectLineage,
  type CanonicalMemoryObjectProvenance,
  type MemoryMetadata,
  type StoreMemoryInput,
  clampImportance,
} from './repository-types.js';
import { buildBaseParams } from './repository-write-params.js';

export interface StoreEpisodeInput {
  userId: string;
  content: string;
  sourceSite: string;
  sourceUrl?: string;
  sessionId?: string;
  workspaceId?: string;
  agentId?: string;
}

export async function storeEpisode(
  pool: pg.Pool,
  input: StoreEpisodeInput,
): Promise<string> {
  return storeEpisodeWithClient(pool as any, input);
}

export async function storeEpisodeWithClient(
  client: pg.PoolClient,
  input: StoreEpisodeInput,
): Promise<string> {
  if (input.workspaceId || input.agentId) {
    const result = await client.query(
      `INSERT INTO episodes (user_id, content, source_site, source_url, session_id, workspace_id, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.userId, input.content, input.sourceSite, input.sourceUrl ?? '', input.sessionId ?? null, input.workspaceId ?? null, input.agentId ?? null],
    );
    return result.rows[0].id;
  }
  const result = await client.query(
    `INSERT INTO episodes (user_id, content, source_site, source_url, session_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.userId, input.content, input.sourceSite, input.sourceUrl ?? '', input.sessionId ?? null],
  );
  return result.rows[0].id;
}

export type { StoreMemoryInput };

export interface StoreCanonicalMemoryObjectInput {
  userId: string;
  objectFamily: CanonicalMemoryObjectFamily;
  payloadFormat?: string;
  canonicalPayload: CanonicalFactPayload;
  provenance: CanonicalMemoryObjectProvenance;
  observedAt?: Date;
  lineage: CanonicalMemoryObjectLineage;
}

export async function storeCanonicalMemoryObject(
  pool: pg.Pool,
  input: StoreCanonicalMemoryObjectInput,
): Promise<string> {
  return storeCanonicalMemoryObjectWithClient(pool as any, input);
}

async function storeCanonicalMemoryObjectWithClient(
  client: pg.PoolClient,
  input: StoreCanonicalMemoryObjectInput,
): Promise<string> {
  const result = await client.query(
    `INSERT INTO canonical_memory_objects (
      user_id,
      object_family,
      payload_format,
      canonical_payload,
      provenance,
      observed_at,
      lineage
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb)
    RETURNING id`,
    [
      input.userId,
      input.objectFamily,
      input.payloadFormat ?? 'json',
      JSON.stringify(input.canonicalPayload),
      JSON.stringify(input.provenance),
      (input.observedAt ?? new Date()).toISOString(),
      JSON.stringify(input.lineage),
    ],
  );
  return result.rows[0].id;
}

export async function storeMemory(pool: pg.Pool, input: StoreMemoryInput): Promise<string> {
  return storeMemoryWithClient(pool as any, input);
}

export async function storeMemoryWithClient(client: pg.PoolClient, input: StoreMemoryInput): Promise<string> {
  const { params, paramCount: baseParamCount } = buildBaseParams(input);
  const workspace = appendWorkspaceParams(input, params, baseParamCount);
  const provenance = appendDocumentProvenanceParams(input, params, workspace.paramCount);
  const temporal = appendTemporalStateParams(input, params, provenance.paramCount);
  const extraColumns = workspace.extraColumns + provenance.extraColumns + temporal.extraColumns;
  const extraPlaceholders = workspace.extraPlaceholders + provenance.extraPlaceholders + temporal.extraPlaceholders;
  const sql = buildInsertSql(input.createdAt, extraColumns, extraPlaceholders, params, temporal.paramCount);
  const result = await client.query(sql, params);
  return result.rows[0].id;
}

const BASE_COLUMNS = 'user_id, content, embedding, memory_type, importance, source_site, source_url, episode_id, status, metadata, keywords, namespace, summary, overview, trust_score, network, opinion_confidence, observation_subject, observed_at';

interface AppendedParams {
  extraColumns: string;
  extraPlaceholders: string;
  paramCount: number;
}

/** Append optional workspace fields (workspace_id, agent_id, visibility) to params. */
function appendWorkspaceParams(
  input: StoreMemoryInput,
  params: unknown[],
  startParamCount: number,
): AppendedParams {
  return appendOptionalColumns(input, params, startParamCount, [
    { key: 'workspaceId', column: 'workspace_id' },
    { key: 'agentId', column: 'agent_id' },
    { key: 'visibility', column: 'visibility' },
  ]);
}

/**
 * Append optional document-provenance fields (raw_document_id,
 * document_chunk_id) to params. Phase 2 indexer sets these on every
 * document-derived memory; conversation ingest leaves them undefined,
 * which keeps the resulting SQL identical to the pre-Phase-2 shape.
 */
function appendDocumentProvenanceParams(
  input: StoreMemoryInput,
  params: unknown[],
  startParamCount: number,
): AppendedParams {
  return appendOptionalColumns(input, params, startParamCount, [
    { key: 'rawDocumentId', column: 'raw_document_id' },
    { key: 'documentChunkId', column: 'document_chunk_id' },
  ]);
}

function appendOptionalColumns(
  input: StoreMemoryInput,
  params: unknown[],
  startParamCount: number,
  fields: Array<{ key: keyof StoreMemoryInput; column: string }>,
): AppendedParams {
  const present = fields.filter((f) => input[f.key] !== undefined);
  if (present.length === 0) {
    return { extraColumns: '', extraPlaceholders: '', paramCount: startParamCount };
  }
  const cols: string[] = [];
  const placeholders: string[] = [];
  let paramCount = startParamCount;
  for (const { key, column } of present) {
    paramCount++;
    cols.push(column);
    placeholders.push(`$${paramCount}`);
    params.push(input[key]);
  }
  return {
    extraColumns: ', ' + cols.join(', '),
    extraPlaceholders: ', ' + placeholders.join(', '),
    paramCount,
  };
}

/**
 * Append BEAM v38 temporal-state fields (state_key, event_start, event_end)
 * to the insert params when present. NULL values still produce a column
 * write because callers explicitly opt in via `stateKey !== undefined`.
 */
function appendTemporalStateParams(
  input: StoreMemoryInput,
  params: unknown[],
  startParamCount: number,
): { extraColumns: string; extraPlaceholders: string; paramCount: number } {
  const hasTemporal =
    input.stateKey !== undefined ||
    input.eventStart !== undefined ||
    input.eventEnd !== undefined;
  if (!hasTemporal) {
    return { extraColumns: '', extraPlaceholders: '', paramCount: startParamCount };
  }
  const fields: string[] = [];
  const placeholders: string[] = [];
  let paramCount = startParamCount;
  const optionalFields: Array<{ key: keyof StoreMemoryInput; column: string }> = [
    { key: 'stateKey', column: 'state_key' },
    { key: 'eventStart', column: 'event_start' },
    { key: 'eventEnd', column: 'event_end' },
  ];
  for (const { key, column } of optionalFields) {
    if (input[key] === undefined) continue;
    paramCount++;
    fields.push(column);
    placeholders.push(`$${paramCount}`);
    const value = input[key];
    params.push(value instanceof Date ? value.toISOString() : value);
  }
  return {
    extraColumns: ', ' + fields.join(', '),
    extraPlaceholders: ', ' + placeholders.join(', '),
    paramCount,
  };
}

/** Build the final INSERT SQL, optionally including created_at. */
function buildInsertSql(
  createdAt: Date | undefined,
  extraColumns: string,
  extraPlaceholders: string,
  params: unknown[],
  paramCount: number,
): string {
  const basePlaceholders = '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19';
  if (createdAt) {
    const nextParam = paramCount + 1;
    params.push(createdAt.toISOString());
    return `INSERT INTO memories (${BASE_COLUMNS}${extraColumns}, created_at) VALUES (${basePlaceholders}${extraPlaceholders}, $${nextParam}) RETURNING id`;
  }
  return `INSERT INTO memories (${BASE_COLUMNS}${extraColumns}) VALUES (${basePlaceholders}${extraPlaceholders}) RETURNING id`;
}

export async function updateMemoryContent(
  pool: pg.Pool,
  userId: string,
  id: string,
  content: string,
  embedding: number[],
  importance: number,
  keywords?: string,
  trustScore?: number,
): Promise<void> {
  await updateMemoryContentWithClient(
    pool as any,
    userId,
    id,
    content,
    embedding,
    importance,
    keywords,
    trustScore,
  );
}

export async function updateMemoryContentWithClient(
  client: pg.PoolClient,
  userId: string,
  id: string,
  content: string,
  embedding: number[],
  importance: number,
  keywords?: string,
  trustScore?: number,
): Promise<void> {
  if (keywords !== undefined) {
    await client.query(
      `UPDATE memories
       SET content = $1, embedding = $2, importance = $3, keywords = $4, trust_score = $5, last_accessed_at = NOW()
       WHERE id = $6 AND user_id = $7 AND deleted_at IS NULL`,
      [
        content,
        pgvector.toSql(embedding),
        clampImportance(importance),
        keywords,
        Math.max(0, Math.min(1, trustScore ?? 1.0)),
        id,
        userId,
      ],
    );
  } else {
    await client.query(
      `UPDATE memories
       SET content = $1, embedding = $2, importance = $3, trust_score = $4, last_accessed_at = NOW()
       WHERE id = $5 AND user_id = $6 AND deleted_at IS NULL`,
      [
        content,
        pgvector.toSql(embedding),
        clampImportance(importance),
        Math.max(0, Math.min(1, trustScore ?? 1.0)),
        id,
        userId,
      ],
    );
  }
}

export async function updateMemoryMetadata(
  pool: pg.Pool,
  userId: string,
  id: string,
  metadata: MemoryMetadata,
): Promise<void> {
  await updateMemoryMetadataWithClient(pool as any, userId, id, metadata);
}

async function updateMemoryMetadataWithClient(
  client: pg.PoolClient,
  userId: string,
  id: string,
  metadata: MemoryMetadata,
): Promise<void> {
  await client.query(
    `UPDATE memories
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
     WHERE id = $2 AND user_id = $3`,
    [JSON.stringify(metadata), id, userId],
  );
}

/**
 * Set the topic_abstraction + topic_embedding columns on a batch of memories.
 * Used by the post-write topic-abstraction processor (Sprint 3 EO experiment).
 *
 * One UPDATE per call; the caller batches by chunk so all facts from a chunk
 * receive the same topic.
 */
export async function updateMemoryTopicAbstraction(
  pool: pg.Pool,
  userId: string,
  memoryIds: string[],
  topic: string,
  topicEmbedding: number[],
): Promise<void> {
  if (memoryIds.length === 0) return;
  await pool.query(
    `UPDATE memories
     SET topic_abstraction = $1, topic_embedding = $2::vector
     WHERE id = ANY($3::uuid[]) AND user_id = $4`,
    [topic, JSON.stringify(topicEmbedding), memoryIds, userId],
  );
}

export async function softDeleteMemory(pool: pg.Pool, userId: string, id: string): Promise<void> {
  await softDeleteMemoryWithClient(pool as any, userId, id);
}

export async function softDeleteMemoryWithClient(client: pg.PoolClient, userId: string, id: string): Promise<void> {
  await client.query(
    `UPDATE memories SET deleted_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
}

export async function softDeleteMemoryInWorkspace(
  pool: pg.Pool,
  id: string,
  workspaceId: string,
): Promise<void> {
  await pool.query(
    `UPDATE memories SET deleted_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [id, workspaceId],
  );
}

/**
 * Soft-delete every memory whose Phase 2 provenance points at the given
 * `raw_document_id`. The Phase 2 indexer's re-chunk path calls this so
 * stale derived memories disappear from `/v1/memories/search` before the
 * fresh generation lands.
 */
export async function softDeleteMemoriesForDocument(
  q: pg.Pool | pg.PoolClient,
  userId: string,
  rawDocumentId: string,
): Promise<number> {
  const result = await q.query(
    `UPDATE memories SET deleted_at = NOW()
      WHERE user_id = $1 AND raw_document_id = $2 AND deleted_at IS NULL`,
    [userId, rawDocumentId],
  );
  return result.rowCount ?? 0;
}

// `softDeleteDocumentCascade` + `deleteBySource` (and the Step 7
// `storage_artifacts` cleanup helpers they share) live in
// `./repository-document-delete.ts`. Import from there directly —
// no re-export here, to avoid a circular dependency with the
// helpers `repository-document-delete.ts` imports back from this
// file.

/**
 * Mark a memory as temporally expired (contradicted/superseded).
 * Unlike soft-delete, expired memories are preserved for temporal queries:
 * "what did I know as of date X?" can still retrieve them.
 */
export async function expireMemory(pool: pg.Pool, userId: string, id: string): Promise<void> {
  await expireMemoryWithClient(pool as any, userId, id);
}

export async function expireMemoryWithClient(client: pg.PoolClient, userId: string, id: string): Promise<void> {
  await client.query(
    `UPDATE memories SET expired_at = NOW()
     WHERE id = $1 AND user_id = $2 AND expired_at IS NULL AND deleted_at IS NULL`,
    [id, userId],
  );
}

export async function touchMemory(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE memories
     SET access_count = access_count + 1, last_accessed_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

export async function updateOpinionConfidence(
  pool: pg.Pool,
  userId: string,
  memoryId: string,
  newConfidence: number,
): Promise<void> {
  await pool.query(
    `UPDATE memories SET opinion_confidence = $1, last_accessed_at = NOW()
     WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [Math.max(0, Math.min(1, newConfidence)), memoryId, userId],
  );
}

export async function backdateMemories(pool: pg.Pool, ids: string[], timestamp: Date): Promise<void> {
  await pool.query(
    `UPDATE memories SET created_at = $1, last_accessed_at = $1 WHERE id = ANY($2::uuid[])`,
    [timestamp.toISOString(), ids],
  );
}


// The full-wipe path (`deleteAll`, `deleteAllForUser`,
// `deleteAllGlobal`) lives in `./repository-wipe.ts` so this module
// stays under the workspace 400-non-comment-LOC cap. Re-export
// `deleteAll` here for existing callers — the rest is internal.
export { deleteAll } from './repository-wipe.js';
