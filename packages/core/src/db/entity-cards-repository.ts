/**
 * EntityCardsRepository — upsert + read for the always-on ENTITY_CARD channel.
 *
 * One row per (user_id, conversation_id, entity_name) holds a durable LLM-
 * synthesized summary card for that entity. The Reflect worker re-synthesizes
 * the card from new observations + prior card text on every run; the search
 * pipeline injects all cards for the active conversation under `## ENTITY_STATE`.
 *
 * Pure SQL via pg.Pool. Mutations fail closed — errors propagate to the caller.
 */
import type pg from 'pg';

export interface EntityCard {
  id: string;
  userId: string;
  conversationId: string;
  entityName: string;
  cardText: string;
  sourceObservationIds: string[];
  version: number;
  updatedAt: Date;
}

export interface UpsertEntityCardInput {
  userId: string;
  conversationId: string;
  entityName: string;
  cardText: string;
  sourceObservationIds: string[];
  version: number;
}

export class EntityCardsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Upsert a card by (userId, conversationId, entityName). Increments version on update. */
  async upsert(input: UpsertEntityCardInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO entity_cards
         (user_id, conversation_id, entity_name, card_text, source_observation_ids, version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id, conversation_id, entity_name) DO UPDATE
         SET card_text = EXCLUDED.card_text,
             source_observation_ids = EXCLUDED.source_observation_ids,
             version = entity_cards.version + 1,
             updated_at = now()`,
      [
        input.userId,
        input.conversationId,
        input.entityName,
        input.cardText,
        input.sourceObservationIds,
        input.version,
      ],
    );
  }

  /** Find cards for a (userId, conversationId), most recently updated first. */
  async findByConversation(
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<EntityCard[]> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, conversation_id, entity_name, card_text,
              source_observation_ids, version, updated_at
       FROM entity_cards
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY updated_at DESC
       LIMIT $3`,
      [userId, conversationId, limit],
    );
    return rows.map(mapRow);
  }
}

function mapRow(r: pg.QueryResultRow): EntityCard {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    entityName: r.entity_name,
    cardText: r.card_text,
    sourceObservationIds: r.source_observation_ids,
    version: r.version,
    updatedAt: r.updated_at,
  };
}
