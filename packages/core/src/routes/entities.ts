/**
 * Entity API routes — profile reads, entity management, and configuration.
 * Thin handlers over existing DB repos; no orchestration service needed.
 * Null repos (feature-gated off) return graceful degraded responses.
 */

import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import type { MemoryRepository } from '../db/memory-repository.js';
import type { EntityRepository } from '../db/repository-entities.js';
import type { UserProfileRepository } from '../db/repository-user-profiles.js';
import type { EntityAttributesRepository } from '../db/repository-entity-attributes.js';
import type { EntityCardsRepository } from '../db/entity-cards-repository.js';
import type { EntitySettingsRepository } from '../db/entity-settings-repository.js';
import { handleRouteError } from './route-errors.js';
import { validateParams, validateQuery, validateBody } from '../middleware/validate.js';
import {
  EntityTypeParamSchema,
  EntityListQuerySchema,
  GetEntityQuerySchema,
  AttributesQuerySchema,
  MemoryHistoryParamSchema,
  EntitySettingsPatchSchema,
  MergeBodySchema,
} from '../schemas/entities.js';
import {
  formatProfile,
  formatAttribute,
  formatRelation,
  formatCard,
  formatHistoryEntry,
  formatSettings,
} from './entity-response-formatters.js';
import type { EntityRelationRow } from '../db/repository-types.js';
import type { EntityCard } from '../db/entity-cards-repository.js';

export interface EntityRouterDeps {
  pool: pg.Pool;
  memory: Pick<MemoryRepository, 'countMemories' | 'deleteAll'>;
  entities: Pick<EntityRepository, 'findByUserAndName' | 'getRelationsForEntity' | 'deleteAll'> | null;
  userProfile: Pick<UserProfileRepository, 'getProfile' | 'deleteForUser'> | null;
  entityAttributes: Pick<EntityAttributesRepository, 'findByEntity' | 'findByAttribute' | 'findByUser' | 'deleteAllForUser'> | null;
  entityCards: Pick<EntityCardsRepository, 'findByUser' | 'findAllByUser' | 'deleteAllForUser'> | null;
  entitySettings: Pick<EntitySettingsRepository, 'getForUser' | 'upsert' | 'deleteForUser'> | null;
}

/** Count per-table entity records before deletion for accurate audit reporting. */
async function countEntityRecords(pool: pg.Pool, userId: string): Promise<{
  entity_attributes: number; profile: number; entity_cards: number;
  entity_settings: number; entity_edges: number; entities: number;
}> {
  const q = (sql: string) => pool.query<{ count: number }>(sql, [userId]).then(r => r.rows[0]?.count ?? 0);
  const [entity_attributes, profile, entity_cards, entity_settings, entity_edges, entities] = await Promise.all([
    q('SELECT COUNT(*)::int AS count FROM entity_attributes WHERE user_id = $1'),
    q('SELECT COUNT(*)::int AS count FROM user_profiles WHERE user_id = $1'),
    q('SELECT COUNT(*)::int AS count FROM entity_cards WHERE user_id = $1'),
    q('SELECT COUNT(*)::int AS count FROM entity_settings WHERE user_id = $1'),
    q('SELECT COUNT(*)::int AS count FROM entity_edges WHERE user_id = $1'),
    q('SELECT COUNT(*)::int AS count FROM entities WHERE user_id = $1'),
  ]);
  return { entity_attributes, profile, entity_cards, entity_settings, entity_edges, entities };
}

/** Resolve entity relations and recent cards, gating on optional repos. */
async function resolveRelationsAndCards(
  deps: Pick<EntityRouterDeps, 'entities' | 'entityCards'>,
  entityId: string,
  entityName: string | undefined,
): Promise<{ relations: EntityRelationRow[]; cards: EntityCard[] }> {
  const entityRow = entityName && deps.entities
    ? await deps.entities.findByUserAndName(entityId, entityName)
    : null;
  const [relations, cards] = await Promise.all([
    entityRow && deps.entities ? deps.entities.getRelationsForEntity(entityRow.id) : Promise.resolve([]),
    deps.entityCards?.findAllByUser(entityId, 5) ?? [],
  ]);
  return { relations, cards };
}

export function createEntityRouter(deps: EntityRouterDeps): Router {
  const router = Router();
  // /merge must be registered before /:entity_type/:entity_id to avoid
  // Express treating "merge" as an entity_type param value.
  registerMergeRoute(router, deps);
  registerProfileRoute(router, deps);
  registerAttributesRoute(router, deps);
  registerHistoryRoute(router, deps);
  registerGetEntityRoute(router, deps);
  registerDeleteEntityRoute(router, deps);
  registerListRoute(router, deps);
  registerSettingsRoute(router, deps);
  return router;
}

function registerProfileRoute(router: Router, deps: EntityRouterDeps): void {
  router.get(
    '/:entity_type/:entity_id/profile',
    validateParams(EntityTypeParamSchema),
    async (req: Request, res: Response) => {
      try {
        const { entity_type, entity_id } = req.params as { entity_type: string; entity_id: string };
        const [profileRow, attributes, memoryCount, lastActiveResult] = await Promise.all([
          deps.userProfile?.getProfile(entity_id) ?? null,
          // C3 fix: fetch ALL attributes for the user scope, not just those
          // where entity_name == entity_id (which would be empty for opaque IDs).
          deps.entityAttributes?.findByUser(entity_id, 20) ?? [],
          deps.memory.countMemories(entity_id),
          deps.pool.query<{ max: Date | null }>(
            'SELECT MAX(updated_at) AS max FROM memories WHERE user_id = $1 AND deleted_at IS NULL',
            [entity_id],
          ),
        ]);
        const lastActive = lastActiveResult.rows[0]?.max ?? null;
        res.json(formatProfile(profileRow, attributes, memoryCount, lastActive, entity_type, entity_id));
      } catch (err) {
        handleRouteError(res, 'GET /v1/entities/:entity_type/:entity_id/profile', err);
      }
    },
  );
}

function registerListRoute(router: Router, deps: EntityRouterDeps): void {
  router.get('/', validateQuery(EntityListQuerySchema), async (req: Request, res: Response) => {
    try {
      const { page, page_size } = req.query as unknown as { page: number; page_size: number };
      const offset = (page - 1) * page_size;
      // I1 fix: entity_type cannot be applied as a WHERE clause here because
      // the memories table does not store entity type — all scopes are keyed
      // by user_id. The param is accepted for forward-compatibility but has
      // no filtering effect; callers must not rely on it for server-side filtering.
      // I3 fix: use a window function so total and rows are consistent (M3 fix).
      // N1 fix: memory_count must be computed in the subquery (against all memory rows),
      // not in the outer query (which would count subquery rows, always 1 per user).
      // The window function for total lives in the outer query only.
      const result = await deps.pool.query<{
        user_id: string;
        memory_count: number;
        last_active: Date | null;
        total: number;
      }>(
        `SELECT user_id,
                memory_count,
                last_active,
                COUNT(*) OVER ()::int AS total
         FROM (
           SELECT user_id,
                  COUNT(*)::int AS memory_count,
                  MAX(updated_at) AS last_active
           FROM memories WHERE deleted_at IS NULL
           GROUP BY user_id
         ) AS counted
         ORDER BY last_active DESC
         LIMIT $1 OFFSET $2`,
        [page_size, offset],
      );
      const entityType = (req.query as Record<string, string>).entity_type ?? 'user';
      const total = result.rows[0]?.total ?? 0;
      res.json({
        entities: result.rows.map((r) => ({
          entity_type: entityType,
          entity_id: r.user_id,
          memory_count: r.memory_count,
          last_active: r.last_active ? r.last_active.toISOString() : null,
        })),
        total,
        page,
        page_size,
      });
    } catch (err) {
      handleRouteError(res, 'GET /v1/entities', err);
    }
  });
}

function registerGetEntityRoute(router: Router, deps: EntityRouterDeps): void {
  router.get(
    '/:entity_type/:entity_id',
    validateParams(EntityTypeParamSchema),
    validateQuery(GetEntityQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { entity_type, entity_id } = req.params as { entity_type: string; entity_id: string };
        // N3 fix: entity_name is optional; without it relations return [] rather than
        // silently matching against the opaque entity_id string.
        const { entity_name } = req.query as unknown as { entity_name?: string };
        const [memoryCount, attributes, lastActiveResult, { relations, cards }] = await Promise.all([
          deps.memory.countMemories(entity_id),
          deps.entityAttributes?.findByUser(entity_id, 50) ?? [],
          deps.pool.query<{ max: Date | null }>(
            'SELECT MAX(updated_at) AS max FROM memories WHERE user_id = $1 AND deleted_at IS NULL',
            [entity_id],
          ),
          resolveRelationsAndCards(deps, entity_id, entity_name),
        ]);
        const lastActive = lastActiveResult.rows[0]?.max ?? null;
        res.json({
          entity_type,
          entity_id,
          memory_count: memoryCount,
          attributes: attributes.map(formatAttribute),
          relations: relations.map(formatRelation),
          recent_cards: cards.map(formatCard),
          updated_at: lastActive ? lastActive.toISOString() : null,
        });
      } catch (err) {
        handleRouteError(res, 'GET /v1/entities/:entity_type/:entity_id', err);
      }
    },
  );
}

function registerDeleteEntityRoute(router: Router, deps: EntityRouterDeps): void {
  router.delete(
    '/:entity_type/:entity_id',
    validateParams(EntityTypeParamSchema),
    async (req: Request, res: Response) => {
      try {
        const { entity_id } = req.params as { entity_id: string };
        // C1 fix: capture counts BEFORE deleting — memory.deleteAll() cascades
        // through repository-wipe.ts, making post-wipe counts inaccurate.
        // N5: counts and deletion are not atomic; minor variance is acceptable
        // for audit but not for GDPR confirmation (future: wrap in a transaction).
        const [memoriesCount, tableCounts] = await Promise.all([
          deps.memory.countMemories(entity_id),
          countEntityRecords(deps.pool, entity_id),
        ]);
        // memory.deleteAll cascades: entity_attributes, user_profiles, entity_cards,
        // entity_settings, entity_relations, and all memory-derived tables.
        await deps.memory.deleteAll(entity_id);
        await deps.pool.query('DELETE FROM entity_edges WHERE user_id = $1', [entity_id]);
        if (deps.entities) await deps.entities.deleteAll(entity_id);
        res.json({ deleted: { memories: memoriesCount, ...tableCounts } });
      } catch (err) {
        handleRouteError(res, 'DELETE /v1/entities/:entity_type/:entity_id', err);
      }
    },
  );
}

function registerAttributesRoute(router: Router, deps: EntityRouterDeps): void {
  router.get(
    '/:entity_type/:entity_id/attributes',
    validateParams(EntityTypeParamSchema),
    validateQuery(AttributesQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { entity_id } = req.params as { entity_id: string };
        const { attribute, limit } = req.query as unknown as { attribute?: string; limit: number };
        const rows = deps.entityAttributes
          ? attribute
            ? await deps.entityAttributes.findByAttribute(entity_id, attribute, limit)
            : await deps.entityAttributes.findByUser(entity_id, limit)
          : [];
        res.json({ attributes: rows.map(formatAttribute) });
      } catch (err) {
        handleRouteError(res, 'GET /v1/entities/:entity_type/:entity_id/attributes', err);
      }
    },
  );
}

function registerHistoryRoute(router: Router, deps: EntityRouterDeps): void {
  router.get(
    '/:entity_type/:entity_id/memories/:memory_id/history',
    validateParams(MemoryHistoryParamSchema),
    async (req: Request, res: Response) => {
      try {
        const { entity_id, memory_id } = req.params as { entity_id: string; memory_id: string };
        const versionResult = await deps.pool.query<{ claim_id: string }>(
          `SELECT claim_id FROM memory_claim_versions
           WHERE user_id = $1 AND (memory_id = $2 OR id IN (
             SELECT previous_version_id FROM memory_claim_versions
             WHERE memory_id = $2 AND user_id = $1
           ))
           LIMIT 1`,
          [entity_id, memory_id],
        );
        if (versionResult.rows.length === 0) {
          res.status(404).json({ error: 'memory not found' });
          return;
        }
        const claimId = versionResult.rows[0].claim_id;
        // C4 fix: exclude the embedding vector column — it's ~6 KB per row
        // and has no meaning to API callers.
        const historyResult = await deps.pool.query(
          `SELECT id, claim_id, user_id, memory_id, content, importance,
                  source_site, source_url, episode_id, valid_from, valid_to,
                  superseded_by_version_id, mutation_type, mutation_reason,
                  previous_version_id, actor_model, contradiction_confidence, created_at
           FROM memory_claim_versions WHERE claim_id = $1 ORDER BY valid_from ASC`,
          [claimId],
        );
        res.json({
          memory_id,
          history: historyResult.rows.map((r, i) => formatHistoryEntry(r, i)),
        });
      } catch (err) {
        handleRouteError(res, 'GET /v1/entities/:entity_type/:entity_id/memories/:memory_id/history', err);
      }
    },
  );
}

function registerSettingsRoute(router: Router, deps: EntityRouterDeps): void {
  router.patch(
    '/:entity_type/:entity_id/settings',
    validateParams(EntityTypeParamSchema),
    validateBody(EntitySettingsPatchSchema),
    async (req: Request, res: Response) => {
      try {
        if (!deps.entitySettings) {
          res.status(503).json({ error: 'entity settings not enabled' });
          return;
        }
        const { entity_id } = req.params as { entity_id: string };
        await deps.entitySettings.upsert(entity_id, req.body as {
          extraction_prompt?: string;
          memory_kinds?: string[];
          decay_enabled?: boolean;
        });
        const row = await deps.entitySettings.getForUser(entity_id);
        if (!row) {
          res.status(500).json({ error: 'failed to persist entity settings' });
          return;
        }
        // I6 fix: return formatted response, not raw DB row.
        res.json(formatSettings(row));
      } catch (err) {
        handleRouteError(res, 'PATCH /v1/entities/:entity_type/:entity_id/settings', err);
      }
    },
  );
}

function registerMergeRoute(router: Router, deps: EntityRouterDeps): void {
  router.post(
    '/merge',
    validateBody(MergeBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { source, target } = req.body as {
          source: { entity_id: string };
          target: { entity_id: string };
        };
        const sourceId = source.entity_id;
        const targetId = target.entity_id;

        // I4 fix: guard against self-merge which would silently delete the entity.
        if (sourceId === targetId) {
          res.status(400).json({ error: 'source and target entity_id must be different' });
          return;
        }

        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');

          // Step 1: Re-scope primary user data to target.
          const [memoriesResult, attrsResult, cardsResult] = await Promise.all([
            client.query('UPDATE memories SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE entity_attributes SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE entity_cards SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
          ]);

          // Step 2: Re-scope memory-linked tables that follow memories.
          // memory_claim_versions and memory_claims must move with memories or the
          // history endpoint breaks (it filters by user_id = entity_id).
          await Promise.all([
            client.query('UPDATE memory_claims SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE memory_claim_versions SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE memory_atomic_facts SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE memory_foresight SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE canonical_memory_objects SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE episodes SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE entity_values SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE reflection_jobs SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
            client.query('UPDATE session_reflections SET user_id = $1 WHERE user_id = $2', [targetId, sourceId]),
          ]);

          // Step 3: entity_edges has UNIQUE(user_id, entity_a, entity_b, memory_id) —
          // use INSERT...ON CONFLICT DO NOTHING to avoid duplicate-key failures when
          // both source and target share co-occurrence edges, then delete source rows.
          await client.query(
            `INSERT INTO entity_edges (user_id, entity_a, entity_b, memory_id)
             SELECT $2, entity_a, entity_b, memory_id FROM entity_edges WHERE user_id = $1
             ON CONFLICT (user_id, entity_a, entity_b, memory_id) DO NOTHING`,
            [sourceId, targetId],
          );
          await client.query('DELETE FROM entity_edges WHERE user_id = $1', [sourceId]);

          // Step 4: first_mention_events has UNIQUE(user_id, memory_id) —
          // same pattern: copy non-conflicting rows, discard conflicts.
          await client.query(
            `INSERT INTO first_mention_events (user_id, memory_id, entity_id, turn_position, created_at)
             SELECT $2, memory_id, entity_id, turn_position, created_at
             FROM first_mention_events WHERE user_id = $1
             ON CONFLICT (user_id, memory_id) DO NOTHING`,
            [sourceId, targetId],
          );
          await client.query('DELETE FROM first_mention_events WHERE user_id = $1', [sourceId]);

          // Step 5: temporal_linkage_list has UNIQUE(user_id, entity_id, memory_id) —
          // delete source rows; they will be rebuilt from the moved memories on next query.
          await client.query('DELETE FROM temporal_linkage_list WHERE user_id = $1', [sourceId]);

          // Step 6: Merge entity_settings — prefer source settings only when target has none.
          await client.query(
            `INSERT INTO entity_settings (user_id, extraction_prompt, memory_kinds, decay_enabled, updated_at)
             SELECT $2, extraction_prompt, memory_kinds, decay_enabled, NOW()
             FROM entity_settings WHERE user_id = $1
             ON CONFLICT (user_id) DO NOTHING`,
            [sourceId, targetId],
          );

          // Step 7: Delete all source-owned records that are either replaced by target's
          // copies or will be regenerated from the moved data.
          await Promise.all([
            client.query('DELETE FROM entity_settings WHERE user_id = $1', [sourceId]),
            client.query('DELETE FROM user_profiles WHERE user_id = $1', [sourceId]),
            client.query('DELETE FROM entity_relations WHERE user_id = $1', [sourceId]),
            client.query('DELETE FROM entities WHERE user_id = $1', [sourceId]),
            // Derived tables that regenerate from memories:
            client.query('DELETE FROM recaps WHERE user_id = $1', [sourceId]),
            client.query('DELETE FROM session_summaries WHERE user_id = $1', [sourceId]),
            client.query('DELETE FROM conv_summaries WHERE user_id = $1', [sourceId]),
            client.query('DELETE FROM lessons WHERE user_id = $1', [sourceId]),
            client.query('DELETE FROM observation_dirty WHERE user_id = $1', [sourceId]),
          ]);

          await client.query('COMMIT');
          res.json({
            merged: {
              memories_moved: memoriesResult.rowCount ?? 0,
              attributes_moved: attrsResult.rowCount ?? 0,
              cards_moved: cardsResult.rowCount ?? 0,
            },
            target_entity_id: targetId,
          });
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        handleRouteError(res, 'POST /v1/entities/merge', err);
      }
    },
  );
}
