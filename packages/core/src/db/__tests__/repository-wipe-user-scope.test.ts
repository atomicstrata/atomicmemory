/**
 * Integration coverage for the shared repository wipe path. The
 * admin test-scope endpoint delegates to this path, so it must remove
 * every user-owned projection table, not only the original memories
 * and raw-document tables.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pgvector from 'pgvector/pg';
import { pool } from '../pool.js';
import { deleteAll } from '../repository-wipe.js';
import { setupTestSchema, unitVector } from './test-fixtures.js';

const USER_A = 'wipe-scope-user-a';
const USER_B = 'wipe-scope-user-b';

const USER_SCOPED_TABLES = [
  'episodes',
  'canonical_memory_objects',
  'memories',
  'memory_atomic_facts',
  'memory_foresight',
  'memory_claims',
  'memory_claim_versions',
  'entities',
  'temporal_linkage_list',
  'first_mention_events',
  'entity_relations',
  'lessons',
  'agent_trust',
  'memory_conflicts',
  'belief_edges',
  'session_summaries',
  'conv_summaries',
  'recaps',
  'user_profiles',
  'entity_attributes',
  'entity_values',
  'session_reflections',
  'reflection_jobs',
  'entity_cards',
  'memory_contradictions',
  'observation_dirty',
] as const;

describe('repository wipe user scope', () => {
  beforeAll(async () => { await setupTestSchema(pool); });
  beforeEach(async () => { await deleteAll(pool); });
  afterAll(async () => { await deleteAll(pool); await pool.end(); });

  it('deleteAll(userId) removes newer user-scoped projection tables only for that user', async () => {
    await insertUserFootprint(USER_A, 1);
    await insertUserFootprint(USER_B, 2);

    await deleteAll(pool, USER_A);

    await expect(countUserRows(USER_A)).resolves.toBe(0);
    await expect(countUserRows(USER_B)).resolves.toBeGreaterThan(0);
    await expect(countJoinRows()).resolves.toEqual({
      memoryEntities: 1,
      memoryLinks: 1,
      visibilityGrants: 1,
    });
  });
});

async function insertUserFootprint(userId: string, seed: number): Promise<void> {
  const vector = pgvector.toSql(unitVector(seed));
  const memoryIds = await insertMemories(userId, vector, seed);
  const entityIds = await insertEntities(userId, vector, seed);
  const claimVersionId = await insertClaim(userId, vector, memoryIds[0]);
  await insertMemoryChildren(userId, vector, memoryIds, entityIds, claimVersionId, seed);
  await insertProjectionRows(userId, vector, memoryIds[0], seed);
}

async function insertMemories(userId: string, vector: string, seed: number): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO memories (user_id, content, embedding, source_site)
     VALUES ($1, $2, $3, 'wipe-test'), ($1, $4, $3, 'wipe-test') RETURNING id`,
    [userId, `memory ${seed}a`, vector, `memory ${seed}b`],
  );
  return result.rows.map((row) => row.id);
}

async function insertEntities(userId: string, vector: string, seed: number): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO entities (user_id, name, normalized_name, entity_type, embedding)
     VALUES ($1, $2, $3, 'person', $4), ($1, $5, $6, 'tool', $4) RETURNING id`,
    [userId, `Alice ${seed}`, `alice ${seed}`, vector, `Tool ${seed}`, `tool ${seed}`],
  );
  return result.rows.map((row) => row.id);
}

async function insertClaim(userId: string, vector: string, memoryId: string): Promise<string> {
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO memory_claims (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  const version = await pool.query<{ id: string }>(
    `INSERT INTO memory_claim_versions
       (claim_id, user_id, memory_id, content, embedding, source_site)
     VALUES ($1, $2, $3, 'claim content', $4, 'wipe-test') RETURNING id`,
    [claim.rows[0].id, userId, memoryId, vector],
  );
  return version.rows[0].id;
}

async function insertMemoryChildren(
  userId: string,
  vector: string,
  memoryIds: string[],
  entityIds: string[],
  claimVersionId: string,
  seed: number,
): Promise<void> {
  await pool.query(`INSERT INTO memory_visibility_grants (memory_id, grantee_agent_id) VALUES ($1, gen_random_uuid())`, [memoryIds[0]]);
  await pool.query(`INSERT INTO memory_evidence (claim_version_id, memory_id, quote_text) VALUES ($1, $2, 'quote')`, [claimVersionId, memoryIds[0]]);
  await pool.query(`INSERT INTO memory_links (source_id, target_id, similarity) VALUES ($1, $2, 0.9)`, [memoryIds[0], memoryIds[1]]);
  await pool.query(`INSERT INTO memory_entities (memory_id, entity_id) VALUES ($1, $2)`, [memoryIds[0], entityIds[0]]);
  await pool.query(`INSERT INTO temporal_linkage_list (user_id, entity_id, memory_id, observation_date, position_in_chain) VALUES ($1, $2, $3, NOW(), 1)`, [userId, entityIds[0], memoryIds[0]]);
  await pool.query(`INSERT INTO first_mention_events (user_id, topic, turn_id, memory_id, position_in_conversation) VALUES ($1, 'topic', $2, $3, 1)`, [userId, seed, memoryIds[0]]);
  await pool.query(`INSERT INTO entity_relations (user_id, source_entity_id, target_entity_id, relation_type, source_memory_id) VALUES ($1, $2, $3, 'uses', $4)`, [userId, entityIds[0], entityIds[1], memoryIds[0]]);
  await pool.query(`INSERT INTO memory_atomic_facts (user_id, parent_memory_id, fact_text, embedding, source_site) VALUES ($1, $2, 'fact', $3, 'wipe-test')`, [userId, memoryIds[0], vector]);
  await pool.query(`INSERT INTO memory_foresight (user_id, parent_memory_id, content, embedding, source_site) VALUES ($1, $2, 'future', $3, 'wipe-test')`, [userId, memoryIds[0], vector]);
}

async function insertProjectionRows(userId: string, vector: string, memoryId: string, seed: number): Promise<void> {
  await pool.query(`INSERT INTO episodes (user_id, content, source_site) VALUES ($1, 'episode', 'wipe-test')`, [userId]);
  await pool.query(`INSERT INTO canonical_memory_objects (user_id, object_family, canonical_payload) VALUES ($1, 'ingested_fact', '{}')`, [userId]);
  await pool.query(`INSERT INTO lessons (user_id, lesson_type, pattern, embedding) VALUES ($1, 'user_reported', 'pattern', $2)`, [userId, vector]);
  await pool.query(`INSERT INTO agent_trust (agent_id, user_id) VALUES ($1, $2)`, [`agent-${seed}`, userId]);
  await pool.query(`INSERT INTO memory_conflicts (user_id, new_memory_id, existing_memory_id) VALUES ($1, $2, $2)`, [userId, memoryId]);
  await pool.query(`INSERT INTO belief_edges (user_id, source_id, target_id, edge_type) VALUES ($1, $2, $2, 'evidence_for')`, [userId, memoryId]);
  await pool.query(`INSERT INTO session_summaries (user_id, session_id, conversation_id, session_index, summary_text, summary_embedding) VALUES ($1, 's', 'c', 1, 'summary', $2)`, [userId, vector]);
  await pool.query(`INSERT INTO conv_summaries (user_id, conversation_id, summary_text, summary_embedding) VALUES ($1, 'c', 'summary', $2)`, [userId, vector]);
  await pool.query(`INSERT INTO recaps (user_id, recap_text, recap_embedding, topic) VALUES ($1, 'recap', $2, 'topic')`, [userId, vector]);
  await pool.query(`INSERT INTO user_profiles (user_id, profile_text, source_memory_ids) VALUES ($1, 'profile', ARRAY[$2])`, [userId, memoryId]);
  await pool.query(`INSERT INTO entity_attributes (user_id, entity_name, attribute_key, attribute_value, value_type) VALUES ($1, 'entity', 'key', 'value', 'string')`, [userId]);
  await pool.query(`INSERT INTO entity_values (user_id, entity, attribute, value, value_type, observed_at, fact_id) VALUES ($1, 'entity', 'key', 'value', 'string', NOW(), $2)`, [userId, memoryId]);
  await pool.query(`INSERT INTO session_reflections (user_id, conversation_id, observation, observation_type, evidence_memory_ids) VALUES ($1, 'c', 'observation', 'event_summary', ARRAY[$2])`, [userId, memoryId]);
  await pool.query(`INSERT INTO reflection_jobs (user_id, conversation_id) VALUES ($1, $2)`, [userId, `c-${seed}`]);
  await pool.query(`INSERT INTO entity_cards (user_id, conversation_id, entity_name, card_text) VALUES ($1, 'c', 'entity', 'card')`, [userId]);
  await pool.query(`INSERT INTO memory_contradictions (user_id, left_memory_id, right_memory_id, left_summary, right_summary) VALUES ($1, $2, $2, 'left', 'right')`, [userId, memoryId]);
  await pool.query(`INSERT INTO observation_dirty (user_id, subject) VALUES ($1, 'subject')`, [userId]);
}

async function countUserRows(userId: string): Promise<number> {
  let total = 0;
  for (const tableName of USER_SCOPED_TABLES) {
    const result = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ${tableName} WHERE user_id = $1`,
      [userId],
    );
    total += result.rows[0].n;
  }
  return total;
}

async function countJoinRows(): Promise<Record<string, number>> {
  const [memoryEntities, memoryLinks, visibilityGrants] = await Promise.all([
    pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM memory_entities'),
    pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM memory_links'),
    pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM memory_visibility_grants'),
  ]);
  return {
    memoryEntities: memoryEntities.rows[0].n,
    memoryLinks: memoryLinks.rows[0].n,
    visibilityGrants: visibilityGrants.rows[0].n,
  };
}
