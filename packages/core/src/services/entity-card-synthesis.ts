/**
 * Entity-card synthesis (BEAM-0.85 — always-on ENTITY_CARD channel).
 *
 * Pure dependency-injected: callers provide `llmCallTool` (typically Sonnet 4.5)
 * and the prior card lookup. For each entity with at least
 * `minObservations` new observations in the current Reflect run, the
 * synthesizer assembles a `buildEntityCardMessages` prompt and calls the
 * model to produce an updated card. The output for one entity has no
 * dependency on the output for any other entity — callers parallelize via
 * Promise.allSettled to fail-soft on individual synthesis errors.
 *
 * No silent error catching: errors from `llmCallTool` propagate to the
 * Promise.allSettled boundary in the caller, which logs each rejection.
 */
import {
  buildEntityCardMessages,
  type EntityCardObservationInput,
} from './reflect-prompts.js';

/** One observation fed into entity grouping + card synthesis. */
export interface ObservationForCard {
  id: string;
  text: string;
  type: string;
  observedAt: Date;
}

export interface EntityCardSynth {
  entityName: string;
  cardText: string;
  sourceObservationIds: string[];
}

/** Schema for the tool-use call that returns the updated card text. */
const ENTITY_CARD_TOOL_SCHEMA = {
  name: 'record_entity_card',
  description: 'Persist the updated entity card text.',
  input_schema: {
    type: 'object',
    properties: { card_text: { type: 'string' } },
    required: ['card_text'],
  },
} as const;

interface EntityCardToolOutput {
  card_text: string;
}

/**
 * Group observations by entity_name. The entity is extracted from
 * entity_state observations whose text begins with "<EntityName>:" or
 * a leading capitalized noun before the first colon/verb.
 *
 * Heuristic (simplified — see compromises in report): the first capitalized
 * token sequence at the start of the observation text. The literal token
 * "User" / "user" maps to the canonical entity "user".
 */
export function groupObservationsByEntity(
  observations: readonly ObservationForCard[],
): Map<string, ObservationForCard[]> {
  const grouped = new Map<string, ObservationForCard[]>();
  for (const obs of observations) {
    const entity = extractEntityName(obs);
    if (!entity) continue;
    const list = grouped.get(entity) ?? [];
    list.push(obs);
    grouped.set(entity, list);
  }
  return grouped;
}

const USER_PREFIX = /^\s*(user|the user|you)\b/i;
const CAPITALIZED_PHRASE = /^([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*){0,2})\b/;

function extractEntityName(obs: ObservationForCard): string | null {
  // entity_state observations are the strongest signal — but any observation
  // that starts with a capitalized noun phrase or the literal "user"
  // contributes to that entity's card.
  const text = obs.text.trim();
  if (USER_PREFIX.test(text)) return 'user';
  const m = CAPITALIZED_PHRASE.exec(text);
  if (m) return m[1].trim();
  return null;
}

export interface SynthesizeCardsDeps {
  llmCallTool: (
    system: string,
    user: string,
    schema: typeof ENTITY_CARD_TOOL_SCHEMA,
  ) => Promise<EntityCardToolOutput>;
  /** Minimum observations an entity needs before its card is synthesized. */
  minObservations: number;
  /** Max entities to synthesize per call (cost ceiling). */
  maxEntities: number;
}

/**
 * Synthesize ENTITY_CARDs for every entity with >= minObservations
 * observations in the current Reflect run. Prior cards are looked up
 * by entity_name; absent entities use the empty prior. Returns one
 * EntityCardSynth per synthesized entity.
 */
export async function synthesizeCards(
  observations: readonly ObservationForCard[],
  priorCards: ReadonlyMap<string, string>,
  deps: SynthesizeCardsDeps,
): Promise<EntityCardSynth[]> {
  const grouped = groupObservationsByEntity(observations);
  const eligible = Array.from(grouped.entries())
    .filter(([, list]) => list.length >= deps.minObservations)
    .slice(0, deps.maxEntities);

  const results: EntityCardSynth[] = [];
  for (const [entityName, list] of eligible) {
    const obsInputs: EntityCardObservationInput[] = list.map(o => ({
      id: o.id,
      text: o.text,
      observedAt: o.observedAt,
    }));
    const priorText = priorCards.get(entityName) ?? null;
    const { system, user } = buildEntityCardMessages(entityName, priorText, obsInputs);
    const out = await deps.llmCallTool(system, user, ENTITY_CARD_TOOL_SCHEMA);
    const cardText = (out.card_text ?? '').trim();
    if (!cardText) continue;
    results.push({
      entityName,
      cardText,
      sourceObservationIds: list.map(o => o.id),
    });
  }
  return results;
}
