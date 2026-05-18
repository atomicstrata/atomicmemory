/**
 * 4-Network memory separation (Hindsight-inspired).
 *
 * Classifies extracted facts into one of four memory networks:
 * - world:       objective third-person facts about the external environment
 * - experience:  first-person biographical records of user actions/interactions
 * - opinion:     subjective beliefs with incrementally-updated confidence [0,1]
 * - observation: synthesized entity profiles (generated async, never from extraction)
 *
 * Also implements opinion confidence evolution:
 *   reinforce (+α), weaken (-α), contradict (-2α), clamped to [0,1].
 */

import type { ExtractedFact } from './extraction.js';

export type MemoryNetwork = 'world' | 'experience' | 'opinion' | 'observation';

export interface NetworkClassification {
  network: MemoryNetwork;
  opinionConfidence: number | null;
}

export type OpinionSignal = 'reinforce' | 'weaken' | 'contradict';

/** Step size for opinion confidence updates. */
const OPINION_ALPHA = 0.1;

/** Default confidence assigned to newly-extracted opinions. */
const OPINION_INITIAL_CONFIDENCE = 0.7;

/** Signals indicating the user is expressing a subjective belief. */
const OPINION_SIGNALS = [
  'i think', 'i believe', 'i feel', 'i prefer', 'in my opinion',
  'i find', 'i like', 'i dislike', 'i hate', 'i love',
  'seems to me', 'i\'d rather', 'my favorite', 'i enjoy',
  'overrated', 'underrated', 'better than', 'worse than',
];

/** Signals indicating an objective world fact (third-person, verifiable). */
const WORLD_SIGNALS = [
  'was released', 'is owned by', 'was founded', 'is headquartered',
  'is the ceo', 'was acquired', 'is a product of', 'is developed by',
  'version ', 'announced', 'launched', 'published', 'is written in',
  'supports', 'is compatible with', 'requires', 'is licensed under',
  'was invented', 'is maintained by', 'merged with',
];

/**
 * Classify an extracted fact into the appropriate memory network.
 * Observation is never produced by extraction — only by ObservationService.
 */
export function classifyNetwork(fact: ExtractedFact): NetworkClassification {
  const lower = fact.fact.toLowerCase();

  // Preferences with subjective language → opinion network
  if (fact.type === 'preference' || OPINION_SIGNALS.some((s) => lower.includes(s))) {
    return { network: 'opinion', opinionConfidence: OPINION_INITIAL_CONFIDENCE };
  }

  // Knowledge facts with world signals → world network
  if (fact.type === 'knowledge' && WORLD_SIGNALS.some((s) => lower.includes(s))) {
    return { network: 'world', opinionConfidence: null };
  }

  // Everything else: experience (first-person biographical)
  return { network: 'experience', opinionConfidence: null };
}

/**
 * Apply a confidence update signal to an opinion memory.
 * Returns the new confidence, clamped to [0, 1].
 *
 * - reinforce:  evidence supports the opinion      → +α
 * - weaken:     mild contradicting evidence         → -α
 * - contradict: strong contradicting evidence       → -2α
 */
export function applyOpinionSignal(currentConfidence: number, signal: OpinionSignal): number {
  const delta = signal === 'reinforce' ? OPINION_ALPHA
    : signal === 'weaken' ? -OPINION_ALPHA
      : -2 * OPINION_ALPHA;
  return Math.max(0.0, Math.min(1.0, currentConfidence + delta));
}

/**
 * Map an AUDN action to the appropriate opinion signal.
 * - NOOP → reinforce (same opinion seen again)
 * - UPDATE → weaken (opinion modified, not replaced)
 * - SUPERSEDE/DELETE → contradict (opinion replaced or removed)
 */
export function audnActionToOpinionSignal(action: string): OpinionSignal {
  if (action === 'NOOP') return 'reinforce';
  if (action === 'UPDATE') return 'weaken';
  return 'contradict';
}
