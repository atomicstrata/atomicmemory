/**
 * Multi-session answer-bearing packaging policy.
 *
 * Groups retrieved memories by source session (episode_id) and promotes
 * answer-bearing atoms — those containing currencies, durations/dates,
 * past-attendance language, or named participants — above generic
 * advisory/recommendation content within each session group.
 *
 * Session groups are ordered chronologically by earliest memory.
 * When all memories share one session (or have no episode_id),
 * falls back to pure chronological sort to avoid unnecessary churn.
 */

import type { SearchResult } from '../db/repository-types.js';

/** Currency amounts: $500, €200, 1000 dollars */
const CURRENCY_PATTERN =
  /(?:\$|€|£|¥)\s*[\d,]+(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|euros?|pounds?|USD|EUR|GBP|yen|yuan)\b/i;

/** Durations: "3 months", "2 weeks"; named dates: "January 15" */
const DURATION_DATE_PATTERN =
  /\b\d+\s*(?:hours?|days?|weeks?|months?|years?|minutes?|seconds?)\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i;

/** Past-attendance verbs indicating the user did something. */
const ATTENDANCE_PATTERN =
  /\b(?:attended|visited|went\s+to|traveled\s+to|participated\s+in|joined|enrolled|signed\s+up|registered|completed|graduated|moved\s+to|flew\s+to|arrived)\b/i;

/** Multi-word proper nouns: "Dr. Smith", "John Carter", "Miss Bee Providore" */
const NAMED_PARTICIPANT_PATTERN =
  /\b(?:Dr\.?\s+[A-Z][a-z]+|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/;

/** Explicit year references: "in 2023", "since 2019" */
const YEAR_REFERENCE_PATTERN = /\b(?:in|since|from|until|before|after|around)\s+\d{4}\b/i;

/** Specific people counts: "15 participants", "200 employees" */
const QUANTITY_PATTERN =
  /\b\d+\s*(?:people|participants|attendees|members|students|employees|guests|speakers|teams?)\b/i;

/** Explicit counts: "3 times", "5 occasions" */
const EXPLICIT_COUNT_PATTERN = /\b\d+\s*(?:times|occasions|instances|sessions)\b/i;

/** Location with proper noun: "at Stanford", "in Berlin" */
const LOCATION_SPECIFICITY_PATTERN = /\b(?:at|in|near|from)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/;

/** State transitions: "switched from X to Y" */
const STATE_TRANSITION_PATTERN = /\b(?:switched|changed|moved|migrated|upgraded|transitioned)\s+(?:from|to)\b/i;

/** Scored/measured results: "scored 170", "rated 4.5" */
const COMPARATIVE_RESULT_PATTERN = /\b(?:scored|rated|ranked|received|earned|achieved)\s+\d/i;

/** Concrete event outcomes: accepted, completed, won, passed, etc. */
const EVENT_OUTCOME_PATTERN =
  /\b(?:accepted|completed|finished|passed|failed|won|lost|received|submitted|launched|published|hired|fired|promoted|resigned|retired|delivered|shipped)\b/i;

/** Generic advisory prose from the assistant. */
const ADVISORY_RECOMMENDATION_PATTERN = /\b(?:(?:assistant|AI)\s+(?:recommended|suggested|advised))\b/i;

/** Vague planning without anchoring specifics. */
const VAGUE_PLANNING_PATTERN = /\b(?:plans?\s+to|wants?\s+to|considering|thinking\s+about)\b/i;

/** Meta-conversation summaries. */
const META_CONVERSATION_PATTERN = /\b(?:discussed|talked\s+about|conversation\s+about)\b/i;

/**
 * Detect whether a memory's content is answer-bearing: contains specific
 * retrievable facts (currencies, durations, attendance, named participants)
 * rather than generic advisory prose.
 */
export function isAnswerBearing(content: string): boolean {
  return (
    CURRENCY_PATTERN.test(content) ||
    DURATION_DATE_PATTERN.test(content) ||
    ATTENDANCE_PATTERN.test(content) ||
    NAMED_PARTICIPANT_PATTERN.test(content) ||
    YEAR_REFERENCE_PATTERN.test(content) ||
    QUANTITY_PATTERN.test(content) ||
    EXPLICIT_COUNT_PATTERN.test(content) ||
    LOCATION_SPECIFICITY_PATTERN.test(content) ||
    STATE_TRANSITION_PATTERN.test(content) ||
    COMPARATIVE_RESULT_PATTERN.test(content) ||
    EVENT_OUTCOME_PATTERN.test(content)
  );
}

/**
 * Detect whether a memory is advisory-only: matches generic advisory patterns
 * AND does NOT match any answer-bearing pattern. Answer-bearing always wins.
 */
export function isAdvisoryOnly(content: string): boolean {
  if (isAnswerBearing(content)) return false;
  return (
    ADVISORY_RECOMMENDATION_PATTERN.test(content) ||
    VAGUE_PLANNING_PATTERN.test(content) ||
    META_CONVERSATION_PATTERN.test(content)
  );
}

/**
 * Budget-aware trim that drops advisory atoms first.
 * Answer-bearing memories always occupy first slots; advisory fills remainder.
 */
export function trimToAnswerBearingBudget(
  memories: SearchResult[],
  maxResults: number,
): SearchResult[] {
  if (memories.length <= maxResults) return sortBySessionPriority(memories);
  const answerBearingPool: SearchResult[] = [];
  const advisoryPool: SearchResult[] = [];
  for (const m of memories) {
    if (isAnswerBearing(m.content)) {
      answerBearingPool.push(m);
    } else {
      advisoryPool.push(m);
    }
  }
  const byScore = (a: SearchResult, b: SearchResult) => b.score - a.score;
  answerBearingPool.sort(byScore);
  advisoryPool.sort(byScore);
  const selected = answerBearingPool.slice(0, maxResults);
  const remaining = maxResults - selected.length;
  if (remaining > 0) {
    selected.push(...advisoryPool.slice(0, remaining));
  }
  return sortBySessionPriority(selected);
}

/** Chronological sort by created_at ascending. */
function sortChronologically(memories: SearchResult[]): SearchResult[] {
  return [...memories].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

/**
 * Three-tier within-session priority for a single memory.
 *
 *   Tier 1 — Direct answer: amounts, dates, counts, outcomes, scored results.
 *            These are the facts most likely to directly answer a question.
 *   Tier 2 — Supporting facts: participants, locations, state transitions,
 *            attendance. Provide context for tier-1 facts.
 *   Tier 3 — Advisory/context: everything else (recommendations, planning,
 *            meta-conversation, or neutral prose).
 *
 * Chronological order is preserved within each tier.
 */
export function withinSessionTier(content: string): 1 | 2 | 3 {
  if (
    CURRENCY_PATTERN.test(content) ||
    DURATION_DATE_PATTERN.test(content) ||
    EXPLICIT_COUNT_PATTERN.test(content) ||
    QUANTITY_PATTERN.test(content) ||
    COMPARATIVE_RESULT_PATTERN.test(content) ||
    YEAR_REFERENCE_PATTERN.test(content) ||
    EVENT_OUTCOME_PATTERN.test(content)
  ) {
    return 1;
  }
  if (
    ATTENDANCE_PATTERN.test(content) ||
    NAMED_PARTICIPANT_PATTERN.test(content) ||
    LOCATION_SPECIFICITY_PATTERN.test(content) ||
    STATE_TRANSITION_PATTERN.test(content)
  ) {
    return 2;
  }
  return 3;
}

/**
 * Within a single session group, promote answer-bearing atoms above
 * advisory atoms using a three-tier ordering. Chronological order is
 * preserved within each tier.
 */
function promoteAnswerBearing(memories: SearchResult[]): SearchResult[] {
  const tier1: SearchResult[] = [];
  const tier2: SearchResult[] = [];
  const tier3: SearchResult[] = [];
  for (const m of memories) {
    const tier = withinSessionTier(m.content);
    if (tier === 1) tier1.push(m);
    else if (tier === 2) tier2.push(m);
    else tier3.push(m);
  }
  return [
    ...sortChronologically(tier1),
    ...sortChronologically(tier2),
    ...sortChronologically(tier3),
  ];
}

/**
 * Sort memories with session-aware answer-bearing promotion.
 *
 * When memories span multiple sessions (distinct episode_ids):
 *   1. Group by episode_id
 *   2. Promote answer-bearing atoms within each group
 *   3. Order groups chronologically by earliest memory
 *
 * When all memories share one session, falls back to chronological sort.
 */
export function sortBySessionPriority(memories: SearchResult[]): SearchResult[] {
  if (memories.length <= 1) return [...memories];

  const episodes = new Set(memories.map((m) => m.episode_id));
  if (episodes.size <= 1) return sortChronologically(memories);

  const groups = new Map<string, SearchResult[]>();
  for (const m of memories) {
    const key = m.episode_id ?? 'no-session';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  const sortedGroups = [...groups.values()]
    .map(promoteAnswerBearing)
    .sort((a, b) => a[0].created_at.getTime() - b[0].created_at.getTime());

  return sortedGroups.flat();
}
