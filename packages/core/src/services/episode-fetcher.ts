/**
 * Injection-channel fetchers (Sprint 3 v1.5 H2 + v1.6 H4 from haiku-080).
 *
 * Extracted from memory-search.ts to keep that orchestrator under the
 * 400-line cap. Owns the side-channel reads (user-profile + recap top-K)
 * that surface as dedicated prompt sections (`## USER PROFILE`,
 * `## EPISODES`) above the standard `<atomicmem_context>` body.
 *
 * The episodes channel is the alternative to routing recaps through the
 * RRF fan-in — recap rows surface to the answer LLM in their own prompt
 * section instead of displacing atomic facts in top-K.
 */

import type { MemoryServiceDeps } from './memory-service-types.js';
import type { EpisodeForInjection } from './retrieval-format.js';
import type { EntityAttributeRow } from '../db/repository-entity-attributes.js';

/** Lower/upper bounds on the recap top-K, to keep the channel signal tight. */
const EPISODES_TOP_K_MIN = 1;
const EPISODES_TOP_K_MAX = 5;

/**
 * Fetch the recap-store top-K rows for the given query embedding when the
 * episodes channel flag is on. Returns `[]` whenever the flag is off, the
 * recap store is absent, or no candidates are found.
 */
export async function fetchEpisodesForInjection(
  deps: MemoryServiceDeps,
  userId: string,
  queryEmbedding: number[],
): Promise<EpisodeForInjection[]> {
  if (!deps.config.episodesChannelEnabled) return [];
  const recapStore = deps.stores.recap;
  if (!recapStore) return [];
  const k = clampTopK(deps.config.episodesChannelTopK);
  try {
    const candidates = await recapStore.findRecapCandidates(userId, queryEmbedding, k);
    return candidates.map((row) => ({
      topic: row.topic,
      narrative: row.recap_text,
    }));
  } catch (err) {
    console.warn(`[episodes] fetch failed for user=${userId}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Fetch the pinned user-profile document (Sprint 3 v1.5 — H2). Returns
 * `undefined` when the channel flag is off, the store is null, or no profile
 * row exists for the user. Fail-soft: log + treat as absent on read errors,
 * never block the search path.
 */
export async function fetchUserProfileText(
  deps: MemoryServiceDeps,
  userId: string,
): Promise<string | undefined> {
  if (!deps.config.userProfileChannelEnabled) return undefined;
  const profileStore = deps.stores.userProfile;
  if (!profileStore) return undefined;
  try {
    const row = await profileStore.getProfile(userId);
    if (row?.profile_text) return row.profile_text;
    return undefined;
  } catch (err) {
    console.warn(`[profile] fetch failed for user=${userId}: ${(err as Error).message}`);
    return undefined;
  }
}

function clampTopK(requested: number): number {
  if (!Number.isFinite(requested)) return EPISODES_TOP_K_MIN;
  return Math.max(EPISODES_TOP_K_MIN, Math.min(EPISODES_TOP_K_MAX, Math.floor(requested)));
}

/**
 * Entity-attribute triple promoted into the injection's `## FACTS` channel
 * (Sprint 4 EAI — Task C). Reaches the answer LLM as a pinned line above
 * the standard memories body so atomic facts survive the top-K cutoff.
 */
export interface EntityFactForInjection {
  entity: string;
  attribute: string;
  value: string;
  observedAt: Date;
}

/** Lower/upper bounds on EAI lookup top-K; mirrors the channel-pattern. */
const EAI_TOP_K_MIN = 5;
const EAI_TOP_K_MAX = 40;

/**
 * Fetch entity-attribute triples likely relevant to the query. Heuristic:
 * extract nouns + numerics + attribute-like tokens from the query, look them
 * up in the EAI by entity_name OR attribute_key match. Returns most-recent
 * first. Fail-soft: returns [] on any error so the search path never breaks.
 */
export async function fetchEntityFactsForInjection(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
): Promise<EntityFactForInjection[]> {
  if (!deps.config.entityAttributesEnabled) return [];
  const repo = deps.stores.entityAttributes;
  if (!repo) return [];
  const tokens = extractLookupTokens(query);
  if (tokens.length === 0) return [];
  try {
    const limit = clampEaiTopK(deps.config.entityAttributesTopK);
    const rows: EntityAttributeRow[] = await repo.findByEntityOrAttribute(userId, tokens, limit);
    return rows.map((r) => ({
      entity: r.entity_name,
      attribute: r.attribute_key,
      value: r.attribute_value,
      observedAt: r.observed_at,
    }));
  } catch (err) {
    console.warn(`[eai] fetch failed user=${userId}: ${(err as Error).message}`);
    return [];
  }
}

function clampEaiTopK(requested: number | undefined): number {
  const value = requested ?? 20;
  if (!Number.isFinite(value)) return EAI_TOP_K_MIN;
  return Math.max(EAI_TOP_K_MIN, Math.min(EAI_TOP_K_MAX, Math.floor(value)));
}

/**
 * Tokenizer-stopwords for the EAI query→lookup heuristic. Conservative list —
 * drops question-frame words and tiny connectives but keeps domain nouns
 * (e.g. "problems", "features", "columns") so they can match `entity_name`
 * or `attribute_key` rows in the EAI.
 */
const STOP_TOKENS = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','is','are','was','were','my','your',
  'i','you','we','they','what','which','when','where','how','many','much','do','did','have','has',
  'had','this','that','these','those','it','its','about','any','some','all','can','could','would',
  'should','will','please','tell','me','show','across','between','from','with','if',
  'over','under','same','different','specific','only','just','simply','really','very','also','too',
]);

const EAI_TOKEN_MAX = 8;
const EAI_TOKEN_MIN_LENGTH = 3;

/** Tokenize the query into lookup-worthy strings. */
export function extractLookupTokens(query: string): string[] {
  const words = (query.toLowerCase().match(/[a-z][a-z0-9_-]+/g) ?? []).filter(
    (w) => w.length >= EAI_TOKEN_MIN_LENGTH && !STOP_TOKENS.has(w),
  );
  const numbers = query.match(/\b\d+\b/g) ?? [];
  // Deduplicate, cap at EAI_TOKEN_MAX to keep SQL parameter list small.
  return Array.from(new Set([...words, ...numbers])).slice(0, EAI_TOKEN_MAX);
}
