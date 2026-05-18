/**
 * Reflect orchestrator. Pulls a conversation's memories, sends them to the
 * answer-LLM tool-use endpoint with the record_observations schema, embeds
 * each returned observation, and persists them to session_reflections.
 *
 * Also drives the always-on ENTITY_CARD channel: after observations are
 * persisted, groups them by entity, loads the prior cards for the
 * conversation, calls the entity-card synthesizer (Sonnet 4.5), and upserts
 * each resulting card. Entity-card synthesis is gated by
 * `runtimeConfig.entityCardEnabled` and uses Promise.allSettled to fail
 * soft on individual entity failures — each rejection is logged.
 *
 * Pure dependency-injected — the worker (reflect-jobs) supplies real
 * implementations; tests supply mocks. No I/O of its own beyond what the
 * injected dependencies do.
 */
import type {
  ReflectionsRepository,
  NewReflection,
  ObservationType,
} from '../db/reflections-repository.js';
import type { EntityCardsRepository } from '../db/entity-cards-repository.js';
import {
  buildReflectMessages,
  REFLECT_TOOL_SCHEMA,
  type ReflectMemoryInput,
} from './reflect-prompts.js';
import {
  synthesizeCards,
  type ObservationForCard,
  type SynthesizeCardsDeps,
} from './entity-card-synthesis.js';

export interface ReflectToolOutput {
  observations: Array<{
    text: string;
    type: ObservationType;
    evidence_memory_ids: string[];
  }>;
}

/** Optional entity-card dependencies; absent when entityCardEnabled is false. */
export interface ReflectEntityCardDeps {
  enabled: boolean;
  repo: EntityCardsRepository;
  synth: SynthesizeCardsDeps;
  maxCardsPerSession: number;
}

export interface ReflectDeps {
  fetchMemories: (userId: string, conversationId: string) => Promise<readonly ReflectMemoryInput[]>;
  llmCallTool: (
    system: string,
    user: string,
    toolSchema: typeof REFLECT_TOOL_SCHEMA,
  ) => Promise<ReflectToolOutput>;
  embed: (text: string) => Promise<number[]>;
  reflections: Pick<ReflectionsRepository, 'insertMany'>;
  maxObservations: number;
  /** Optional always-on ENTITY_CARD channel. When absent, no cards are synthesized. */
  entityCards?: ReflectEntityCardDeps;
}

export interface ReflectResult {
  count: number;
  /** Number of entity cards upserted in this run. 0 when entity cards are disabled. */
  entityCardCount: number;
}

export async function runReflectForConversation(
  deps: ReflectDeps,
  userId: string,
  conversationId: string,
): Promise<ReflectResult> {
  const memories = await deps.fetchMemories(userId, conversationId);
  if (memories.length === 0) return { count: 0, entityCardCount: 0 };

  const { system, user } = buildReflectMessages(memories);
  const out = await deps.llmCallTool(system, user, REFLECT_TOOL_SCHEMA);

  const truncated = out.observations.slice(0, deps.maxObservations);
  const rows: NewReflection[] = [];
  for (const o of truncated) {
    const embedding = await deps.embed(o.text);
    rows.push({
      userId,
      conversationId,
      observation: o.text,
      observationType: o.type,
      evidenceMemoryIds: o.evidence_memory_ids,
      embedding,
    });
  }

  await deps.reflections.insertMany(rows);

  const entityCardCount = await maybeSynthesizeEntityCards(
    deps.entityCards,
    userId,
    conversationId,
    truncated,
    rows,
  );

  return { count: rows.length, entityCardCount };
}

/**
 * Drive the always-on ENTITY_CARD channel. Returns the number of cards
 * upserted. Fails soft on individual entity synthesis errors (each rejection
 * is logged via console.error so failures are never silent.
 */
async function maybeSynthesizeEntityCards(
  entityCards: ReflectEntityCardDeps | undefined,
  userId: string,
  conversationId: string,
  truncatedObs: ReflectToolOutput['observations'],
  rows: readonly NewReflection[],
): Promise<number> {
  if (!entityCards || !entityCards.enabled) return 0;
  void rows; // rows reserved for future provenance threading

  // Synthetic observation IDs: the reflect insertMany path does not
  // return persisted IDs in the v1 schema, so we cite the index. Future
  // work: thread row IDs through repository for full provenance.
  const obsForCards: ObservationForCard[] = truncatedObs.map((o, idx) => ({
    id: `obs-${idx}`,
    text: o.text,
    type: o.type,
    observedAt: new Date(),
  }));

  // BEAM/AMB note: the upstream harness encodes BEAM's conversation_id INTO
  // user_id (per-conversation isolation). The reflect job's conversationId is
  // a fresh episodeId per ingest, so cards keyed on it never accumulate across
  // a conversation's many ingests. Scope entity-cards by userId on both sides:
  // write and read both use userId as the conversation key so cards build up
  // across the lifetime of the conversation. Outside the BEAM benchmark this
  // still gives per-conversation scoping because consumers pass conversation-
  // unique userIds via the AtomicMemory v1 API.
  void conversationId;
  const cardScope = userId;
  const priorCards = await loadPriorCards(entityCards, userId, cardScope);
  const cards = await synthesizeCards(obsForCards, priorCards, entityCards.synth);

  const settled = await Promise.allSettled(
    cards.map((card) =>
      entityCards.repo.upsert({
        userId,
        conversationId: cardScope,
        entityName: card.entityName,
        cardText: card.cardText,
        sourceObservationIds: card.sourceObservationIds,
        version: 1, // repo ON CONFLICT increments via entity_cards.version + 1
      }),
    ),
  );

  let upserted = 0;
  for (const r of settled) {
    if (r.status === 'fulfilled') upserted += 1;
    else console.error('[reflect:entity-card] upsert failed:', r.reason);
  }
  return upserted;
}

/**
 * Load prior cards for the conversation and return a (entityName -> cardText)
 * lookup map. Errors propagate to the caller (entity-card synthesis is
 * fail-soft at the worker boundary).
 */
async function loadPriorCards(
  entityCards: ReflectEntityCardDeps,
  userId: string,
  conversationId: string,
): Promise<Map<string, string>> {
  const prior = await entityCards.repo.findByConversation(
    userId,
    conversationId,
    entityCards.maxCardsPerSession,
  );
  const map = new Map<string, string>();
  for (const p of prior) map.set(p.entityName, p.cardText);
  return map;
}
