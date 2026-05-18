/**
 * Structured claim/version history repository.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import {
  type ClaimRow,
  type ClaimVersionRow,
  type MutationSummary,
  type MutationType,
  type RelationType,
  type SearchResult,
  clampImportance,
  normalizeSearchRow,
  normalizeVersionRow,
} from './repository-types.js';
import {
  type CreateClaimVersionInput,
  buildClaimVersionInsertParams,
  buildCreateClaimParams,
} from './repository-claim-version-params.js';

export interface MutationProvenance {
  mutationType: MutationType;
  mutationReason?: string;
  previousVersionId?: string;
  actorModel?: string;
  contradictionConfidence?: number;
}

export interface ClaimSlotInput {
  slotKey: string;
  subjectEntityId: string;
  relationType: RelationType;
  objectEntityId: string;
}

export interface ClaimSlotTarget {
  claimId: string;
  versionId: string;
  memoryId: string;
}

export interface SlotBackfillCandidate {
  claimId: string;
  userId: string;
  memoryId: string;
}

export class ClaimRepository {
  constructor(private pool: pg.Pool) {}

  async createClaim(
    userId: string,
    claimType: string,
    validAt?: Date,
    slot?: ClaimSlotInput | null,
  ): Promise<string> {
    return this.createClaimWithClient(this.pool as any, userId, claimType, validAt, slot);
  }

  async createClaimWithClient(
    client: pg.PoolClient,
    userId: string,
    claimType: string,
    validAt?: Date,
    slot?: ClaimSlotInput | null,
  ): Promise<string> {
    const result = await client.query(
      `INSERT INTO memory_claims (
         user_id, claim_type, slot_key, subject_entity_id, relation_type, object_entity_id, valid_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      buildCreateClaimParams(userId, claimType, validAt, slot),
    );
    return result.rows[0].id;
  }

  async getClaim(id: string, userId: string): Promise<ClaimRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM memory_claims WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return result.rows[0] ?? null;
  }

  async getActiveClaimTargetBySlot(
    userId: string,
    slotKey: string,
  ): Promise<ClaimSlotTarget | null> {
    const result = await this.pool.query(
      `SELECT
         c.id AS claim_id,
         cv.id AS version_id,
         cv.memory_id
       FROM memory_claims c
       JOIN memory_claim_versions cv ON cv.id = c.current_version_id
       WHERE c.user_id = $1
         AND c.slot_key = $2
         AND c.status = 'active'
         AND c.invalid_at IS NULL
         AND cv.memory_id IS NOT NULL
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [userId, slotKey],
    );
    if (result.rows.length === 0) return null;
    return {
      claimId: result.rows[0].claim_id,
      versionId: result.rows[0].version_id,
      memoryId: result.rows[0].memory_id,
    };
  }

  async listClaimsMissingSlots(userId: string): Promise<SlotBackfillCandidate[]> {
    const result = await this.pool.query(
      `SELECT
         c.id AS claim_id,
         c.user_id,
         cv.memory_id
       FROM memory_claims c
       JOIN memory_claim_versions cv ON cv.id = c.current_version_id
       WHERE c.user_id = $1
         AND c.slot_key IS NULL
         AND c.status = 'active'
         AND c.invalid_at IS NULL
         AND cv.memory_id IS NOT NULL
       ORDER BY c.created_at ASC`,
      [userId],
    );
    return result.rows.map((row) => ({
      claimId: row.claim_id,
      userId: row.user_id,
      memoryId: row.memory_id,
    }));
  }

  async updateClaimSlot(
    userId: string,
    claimId: string,
    slot: ClaimSlotInput,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE memory_claims
       SET slot_key = $1,
           subject_entity_id = $2,
           relation_type = $3,
           object_entity_id = $4,
           updated_at = NOW()
       WHERE id = $5
         AND user_id = $6
         AND slot_key IS NULL`,
      [
        slot.slotKey,
        slot.subjectEntityId,
        slot.relationType,
        slot.objectEntityId,
        claimId,
        userId,
      ],
    );
  }

  async setClaimCurrentVersion(
    claimId: string,
    versionId: string | null,
    status: string = 'active',
    validAt?: Date,
  ): Promise<void> {
    await this.setClaimCurrentVersionWithClient(this.pool as any, claimId, versionId, status, validAt);
  }

  async setClaimCurrentVersionWithClient(
    client: pg.PoolClient,
    claimId: string,
    versionId: string | null,
    status: string = 'active',
    validAt?: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE memory_claims
       SET current_version_id = $1,
           status = $2,
           valid_at = CASE
             WHEN $4::timestamptz IS NULL THEN valid_at
             ELSE LEAST(valid_at, $4::timestamptz)
           END,
           invalid_at = NULL,
           invalidated_at = NULL,
           invalidated_by_version_id = NULL,
           updated_at = NOW()
       WHERE id = $3`,
      [versionId, status, claimId, validAt ?? null],
    );
  }

  async invalidateClaim(
    userId: string,
    claimId: string,
    invalidAt: Date = new Date(),
    invalidatedByVersionId: string | null = null,
    status: string = 'deleted',
  ): Promise<void> {
    await this.invalidateClaimWithClient(
      this.pool as any,
      userId,
      claimId,
      invalidAt,
      invalidatedByVersionId,
      status,
    );
  }

  async invalidateClaimWithClient(
    client: pg.PoolClient,
    userId: string,
    claimId: string,
    invalidAt: Date = new Date(),
    invalidatedByVersionId: string | null = null,
    status: string = 'deleted',
  ): Promise<void> {
    await client.query(
      `UPDATE memory_claims
       SET current_version_id = NULL,
           status = $1,
           invalid_at = $2,
           invalidated_at = NOW(),
           invalidated_by_version_id = $3,
           updated_at = NOW()
       WHERE id = $4 AND user_id = $5`,
      [status, invalidAt, invalidatedByVersionId, claimId, userId],
    );
  }

  async createClaimVersion(input: CreateClaimVersionInput): Promise<string> {
    return this.createClaimVersionWithClient(this.pool as any, input);
  }

  async createClaimVersionWithClient(
    client: pg.PoolClient,
    input: CreateClaimVersionInput,
  ): Promise<string> {
    const validFrom = input.validFrom ?? new Date();
    const result = await client.query(
      `INSERT INTO memory_claim_versions
       (claim_id, user_id, memory_id, content, embedding, importance, source_site, source_url, episode_id, valid_from,
        mutation_type, mutation_reason, previous_version_id, actor_model, contradiction_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      buildClaimVersionInsertParams(input, validFrom),
    );
    await client.query(
      `UPDATE memory_claims
       SET valid_at = LEAST(valid_at, $1::timestamptz), updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [validFrom, input.claimId, input.userId],
    );
    return result.rows[0].id;
  }

  async getClaimVersionByMemoryId(userId: string, memoryId: string): Promise<ClaimVersionRow | null> {
    return this.getClaimVersionByMemoryIdWithClient(this.pool as any, userId, memoryId);
  }

  async getClaimVersionByMemoryIdWithClient(client: pg.PoolClient, userId: string, memoryId: string): Promise<ClaimVersionRow | null> {
    const result = await client.query(
      `SELECT * FROM memory_claim_versions
       WHERE user_id = $1 AND memory_id = $2`,
      [userId, memoryId],
    );
    return result.rows[0] ? normalizeVersionRow(result.rows[0]) : null;
  }

  async getClaimVersion(versionId: string, userId: string): Promise<ClaimVersionRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM memory_claim_versions WHERE id = $1 AND user_id = $2`,
      [versionId, userId],
    );
    return result.rows[0] ? normalizeVersionRow(result.rows[0]) : null;
  }

  async getClaimVersionAtTime(
    claimId: string,
    userId: string,
    asOf: string,
  ): Promise<ClaimVersionRow | null> {
    const result = await this.pool.query(
      `SELECT cv.*
       FROM memory_claims c
       JOIN memory_claim_versions cv ON cv.claim_id = c.id
       WHERE c.id = $1
         AND c.user_id = $2
         AND c.valid_at <= $3::timestamptz
         AND (c.invalid_at IS NULL OR c.invalid_at > $3::timestamptz)
         AND cv.valid_from <= $3::timestamptz
         AND (cv.valid_to IS NULL OR cv.valid_to > $3::timestamptz)
       ORDER BY cv.valid_from DESC, cv.created_at DESC
       LIMIT 1`,
      [claimId, userId, asOf],
    );
    return result.rows[0] ? normalizeVersionRow(result.rows[0]) : null;
  }

  async listClaimVersions(claimId: string): Promise<ClaimVersionRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM memory_claim_versions
       WHERE claim_id = $1 ORDER BY valid_from ASC`,
      [claimId],
    );
    return result.rows.map(normalizeVersionRow);
  }

  /**
   * Create a new version for an UPDATE mutation, preserving the old version
   * in the version history. The old version gets valid_to set and the new
   * version becomes current.
   */
  async createUpdateVersion(input: {
    oldVersionId: string;
    claimId: string;
    userId: string;
    memoryId: string;
    content: string;
    embedding: number[];
    importance: number;
    sourceSite: string;
    sourceUrl?: string;
    episodeId?: string;
    validFrom?: Date;
    mutationReason?: string;
    actorModel?: string;
  }): Promise<string> {
    const validFrom = input.validFrom ?? new Date();
    // Close old version and release its memory_id (UNIQUE constraint)
    await this.supersedeClaimVersion(input.userId, input.oldVersionId, null, validFrom);
    await this.pool.query(
      `UPDATE memory_claim_versions SET memory_id = NULL WHERE id = $1`,
      [input.oldVersionId],
    );
    // Create new version with provenance
    const newVersionId = await this.createClaimVersion({
      claimId: input.claimId,
      userId: input.userId,
      memoryId: input.memoryId,
      content: input.content,
      embedding: input.embedding,
      importance: input.importance,
      sourceSite: input.sourceSite,
      sourceUrl: input.sourceUrl,
      episodeId: input.episodeId,
      validFrom,
      provenance: {
        mutationType: 'update',
        mutationReason: input.mutationReason,
        previousVersionId: input.oldVersionId,
        actorModel: input.actorModel,
      },
    });
    // Link old → new
    await this.pool.query(
      `UPDATE memory_claim_versions SET superseded_by_version_id = $1 WHERE id = $2`,
      [newVersionId, input.oldVersionId],
    );
    // Update claim pointer
    await this.setClaimCurrentVersion(input.claimId, newVersionId, 'active', validFrom);
    return newVersionId;
  }

  async supersedeClaimVersion(userId: string, versionId: string, supersededByVersionId: string | null, validTo: Date = new Date()): Promise<void> {
    await this.supersedeClaimVersionWithClient(this.pool as any, userId, versionId, supersededByVersionId, validTo);
  }

  async supersedeClaimVersionWithClient(client: pg.PoolClient, userId: string, versionId: string, supersededByVersionId: string | null, validTo: Date = new Date()): Promise<void> {
    await client.query(
      `UPDATE memory_claim_versions
       SET valid_to = $1, superseded_by_version_id = $2
       WHERE id = $3 AND user_id = $4`,
      [validTo, supersededByVersionId, versionId, userId],
    );
  }

  async addEvidence(input: { claimVersionId: string; episodeId?: string; memoryId?: string; quoteText?: string; speaker?: string }): Promise<void> {
    await this.addEvidenceWithClient(this.pool as any, input);
  }

  async addEvidenceWithClient(client: pg.PoolClient, input: { claimVersionId: string; episodeId?: string; memoryId?: string; quoteText?: string; speaker?: string }): Promise<void> {
    await client.query(
      `INSERT INTO memory_evidence (claim_version_id, episode_id, memory_id, quote_text, speaker)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.claimVersionId, input.episodeId ?? null, input.memoryId ?? null, input.quoteText ?? '', input.speaker ?? null],
    );
  }

  async searchClaimVersions(userId: string, queryEmbedding: number[], limit: number, asOf: string, sourceSite?: string): Promise<SearchResult[]> {
    const result = await this.pool.query(
      `SELECT
         COALESCE(cv.memory_id::text, cv.id::text) AS id,
         cv.user_id,
         cv.content,
         cv.embedding,
         'semantic' AS memory_type,
         cv.importance,
         cv.source_site,
         cv.source_url,
         cv.episode_id,
         cv.valid_from AS created_at,
         cv.valid_from AS last_accessed_at,
         0::int AS access_count,
         'active'::text AS status,
         '{}'::jsonb AS metadata,
         NULL::timestamptz AS deleted_at,
         1 - (cv.embedding <=> $1) AS similarity,
         (
           2.0 * (1 - (cv.embedding <=> $1))
           + 1.0 * cv.importance
           + 1.0 * EXP(-EXTRACT(EPOCH FROM ($4::timestamptz - cv.valid_from)) / 2592000.0)
         ) AS score
       FROM memory_claim_versions cv
       JOIN memory_claims c ON c.id = cv.claim_id
       WHERE cv.user_id = $2
         AND c.user_id = $2
         AND c.valid_at <= $4::timestamptz
         AND (c.invalid_at IS NULL OR c.invalid_at > $4::timestamptz)
         AND cv.valid_from <= $4::timestamptz
         AND (cv.valid_to IS NULL OR cv.valid_to > $4::timestamptz)
         ${sourceSite ? 'AND cv.source_site = $5' : ''}
       ORDER BY score DESC
       LIMIT $3`,
      buildHistoricalParams(queryEmbedding, userId, limit, asOf, sourceSite),
    );
    return result.rows.map(normalizeSearchRow);
  }

  async countClaims(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM memory_claims WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0].count;
  }

  async countOpenClaimVersions(claimId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM memory_claim_versions WHERE claim_id = $1 AND valid_to IS NULL`,
      [claimId],
    );
    return result.rows[0].count;
  }

  /**
   * Get the full mutation history for a claim, ordered chronologically.
   * Returns all versions including superseded ones, with provenance metadata.
   */
  async getMutationHistory(claimId: string): Promise<ClaimVersionRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM memory_claim_versions
       WHERE claim_id = $1
       ORDER BY valid_from ASC`,
      [claimId],
    );
    return result.rows.map(normalizeVersionRow);
  }

  /**
   * Find the claim associated with a memory ID (even if the memory is deleted).
   */
  async findClaimByMemoryId(userId: string, memoryId: string): Promise<{ claimId: string; versions: ClaimVersionRow[] } | null> {
    const versionResult = await this.pool.query(
      `SELECT claim_id FROM memory_claim_versions
       WHERE user_id = $1 AND (memory_id = $2 OR id IN (
         SELECT previous_version_id FROM memory_claim_versions WHERE memory_id = $2
       ))
       LIMIT 1`,
      [userId, memoryId],
    );
    if (versionResult.rows.length === 0) return null;
    const claimId = versionResult.rows[0].claim_id;
    const versions = await this.getMutationHistory(claimId);
    return { claimId, versions };
  }

  /**
   * Get aggregate mutation stats for a user: counts by mutation type,
   * total versions, active vs superseded counts. Used for mutation audit trail.
   */
  async getUserMutationSummary(userId: string): Promise<MutationSummary> {
    const [typeCounts, totals] = await Promise.all([
      this.pool.query(
        `SELECT mutation_type, COUNT(*)::int AS count
         FROM memory_claim_versions WHERE user_id = $1 AND mutation_type IS NOT NULL
         GROUP BY mutation_type ORDER BY count DESC`,
        [userId],
      ),
      this.pool.query(
        `SELECT
           COUNT(*)::int AS total_versions,
           COUNT(*) FILTER (WHERE valid_to IS NULL)::int AS active_versions,
           COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::int AS superseded_versions,
           COUNT(DISTINCT claim_id)::int AS total_claims
         FROM memory_claim_versions WHERE user_id = $1`,
        [userId],
      ),
    ]);

    const byType: Record<string, number> = {};
    for (const row of typeCounts.rows) {
      byType[row.mutation_type] = row.count;
    }

    const t = totals.rows[0];
    return {
      totalVersions: t.total_versions,
      activeVersions: t.active_versions,
      supersededVersions: t.superseded_versions,
      totalClaims: t.total_claims,
      byMutationType: byType,
    };
  }

  /**
   * Trace the supersession chain forward from a given version ID.
   * Returns the sequence of versions that replaced each other,
   * enabling "why did this memory change?" debugging.
   */
  async getReversalChain(userId: string, startVersionId: string, maxDepth: number = 20): Promise<ClaimVersionRow[]> {
    const chain: ClaimVersionRow[] = [];
    let currentId: string | null = startVersionId;

    while (currentId && chain.length < maxDepth) {
      const result = await this.pool.query(
        `SELECT * FROM memory_claim_versions WHERE id = $1 AND user_id = $2`,
        [currentId, userId],
      );
      if (result.rows.length === 0) break;
      const version = normalizeVersionRow(result.rows[0]);
      chain.push(version);
      currentId = version.superseded_by_version_id;
    }

    return chain;
  }

  /**
   * Get recent mutations across all claims for a user, ordered newest first.
   * Useful for "what changed recently?" debugging.
   */
  async getRecentMutations(userId: string, limit: number = 20): Promise<ClaimVersionRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM memory_claim_versions
       WHERE user_id = $1 AND mutation_type IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(100, limit))],
    );
    return result.rows.map(normalizeVersionRow);
  }

  async deleteAll(userId?: string): Promise<void> {
    const params = userId ? [userId] : [];
    const where = userId ? ' WHERE user_id = $1' : '';
    await this.pool.query(`DELETE FROM memory_evidence WHERE claim_version_id IN (SELECT id FROM memory_claim_versions${where})`, params);
    await this.pool.query(`DELETE FROM memory_claim_versions${where}`, params);
    await this.pool.query(`DELETE FROM memory_claims${where}`, params);
  }
}

function buildHistoricalParams(queryEmbedding: number[], userId: string, limit: number, asOf: string, sourceSite?: string): unknown[] {
  const params: unknown[] = [pgvector.toSql(queryEmbedding), userId, Math.max(1, Math.min(100, limit)), asOf];
  if (sourceSite) params.push(sourceSite);
  return params;
}
