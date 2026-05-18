/**
 * Query-aware temporal evidence formatting.
 *
 * Produces compact date-bearing evidence blocks for temporal questions. For
 * repeated-event comparisons it emits explicit first/second endpoints; for
 * broader temporal questions it emits a small set of high-overlap candidate
 * memories with their dates.
 */

import type { SearchResult } from '../db/memory-repository.js';
import { formatDateLabel, formatDuration } from './temporal-format.js';

const REPEATED_EVENT_QUERY = /\bbetween\b[\s\S]*\bfirst\b[\s\S]*\bsecond\b|\bfirst\b[\s\S]*\bsecond\b/i;
const TEMPORAL_QUERY = /\b(when|how long|how many months|how many years|how many weeks|how many days|between|before|after|as of|recently)\b/i;
const DURATION_QUERY = /\b(how long|how many months|how many years|how many weeks|how many days|between|before|after)\b/i;
const EVIDENCE_MAX_CHARS = 160;
const QUERY_TERM_MIN_LENGTH = 4;
const GENERAL_TEMPORAL_LIMIT = 3;
const STEM_SUFFIXES = ['ing', 'ed', 'es', 's'];
const SUBJECT_MATCH_BONUS = 2;
const EVENT_GROUP_MATCH_BONUS = 2;
const PLANNING_PENALTY = 3;
const DURATION_ENDPOINT_LIMIT = 2;
const PLANNING_MARKERS = [
  'plan to', 'planned to', 'planning to', 'going to', 'will ', 'wants to',
  'want to', 'thinking of', 'thinking about', 'considering', 'decided to make',
  'make a new appointment', 'book a new appointment',
];
const QUERY_SUBJECT_STOP_WORDS = new Set([
  'When', 'What', 'Where', 'Why', 'How', 'Who', 'Which',
  'Did', 'Does', 'Do', 'Has', 'Have', 'Had',
  'The', 'A', 'An', 'As', 'Of', 'And', 'Or',
  'First', 'Second',
]);
const MONTH_NAMES = new Set([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

const QUERY_EVENT_STOP_WORDS = new Set([
  'between', 'first', 'second', 'months', 'month', 'weeks', 'week',
  'days', 'many', 'much', 'long', 'lapsed', 'elapsed', 'passed',
  'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this',
  'before', 'after', 'recently', 'start', 'started', 'plan', 'planned',
  'recent', 'current', 'present', 'did', 'does', 'have', 'been',
]);

const EVENT_SYNONYMS: Record<string, string[]> = {
  appointment: ['appointment', 'appointments', 'check-up', 'checkup', 'check up', 'visit'],
  doctor: ['doctor', "doctor's", 'doctors', 'doc', 'medical', 'health'],
};

const IRREGULAR_NORMALIZATION: Record<string, string> = {
  won: 'win',
  winning: 'win',
  met: 'meet',
  meeting: 'meet',
  began: 'begin',
  begun: 'begin',
  started: 'start',
  starting: 'start',
  moved: 'move',
  moving: 'move',
  dated: 'date',
  dating: 'date',
  adopted: 'adopt',
  adopting: 'adopt',
  adoption: 'adopt',
  expanded: 'expand',
  expanding: 'expand',
  presence: 'present',
};

/** Reverse index: each synonym → its canonical key. Built once at module load. */
const SYNONYM_TO_CANONICAL: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const [canonical, synonyms] of Object.entries(EVENT_SYNONYMS)) {
    for (const synonym of synonyms) index.set(synonym, canonical);
  }
  return index;
})();

interface EndpointCandidate {
  dateKey: string;
  memory: SearchResult;
  score: number;
}

/**
 * A concept group is the synonym list for one canonical event term in the
 * query. "Doctor appointment" produces two groups (the doctor synonyms and
 * the appointment synonyms); a candidate must hit AT LEAST ONE synonym in
 * EVERY group to qualify, otherwise a memory mentioning only "doctor" and
 * another mentioning only "appointment" would falsely become endpoints.
 */
type ConceptGroup = string[];

interface TemporalCandidate {
  dateKey: string;
  memory: SearchResult;
  score: number;
  subjectMatches: number;
  eventGroupMatches: number;
  isPlanningLike: boolean;
}

export function buildTemporalEvidenceBlock(
  memories: SearchResult[],
  query: string,
): string {
  const repeatedEventBlock = buildRepeatedEventEndpointBlock(memories, query);
  if (repeatedEventBlock) return repeatedEventBlock;
  return buildGeneralTemporalEvidenceBlock(memories, query);
}

/** Build endpoint lines for repeated-event temporal comparisons. */
export function buildRepeatedEventEndpointBlock(
  memories: SearchResult[],
  query: string,
): string {
  if (!isRepeatedEventQuery(query)) return '';
  const conceptGroups = extractEventConceptGroups(query);
  if (conceptGroups.length === 0) return '';

  const candidates = findEndpointCandidates(memories, conceptGroups);
  const endpoints = selectDistinctDateEndpoints(candidates);
  if (endpoints.length < 2) return '';

  const [first, second] = endpoints;
  const days = diffDays(first.memory.created_at, second.memory.created_at);
  return [
    'Repeated event endpoints:',
    formatEndpointLine('first matching event', first),
    formatEndpointLine('second matching event', second),
    `- elapsed between endpoints: ${formatDuration(days)}`,
  ].join('\n');
}

function isRepeatedEventQuery(query: string): boolean {
  return REPEATED_EVENT_QUERY.test(query.toLowerCase());
}

function buildGeneralTemporalEvidenceBlock(
  memories: SearchResult[],
  query: string,
): string {
  if (!TEMPORAL_QUERY.test(query.toLowerCase())) return '';
  const queryTerms = extractGeneralTemporalTerms(query);
  const subjectTerms = extractQuerySubjects(query);
  const conceptGroups = extractEventConceptGroups(query);
  if (queryTerms.length === 0) return '';
  const candidates = selectGeneralTemporalCandidates(memories, queryTerms, subjectTerms, conceptGroups);
  if (candidates.length === 0) return '';
  const endpointLines = buildGeneralDurationEndpointLines(candidates, query);
  if (endpointLines.length > 0) {
    return ['Temporal evidence candidates:', ...endpointLines].join('\n');
  }
  return [
    'Temporal evidence candidates:',
    ...candidates.map((candidate) => formatEndpointLine('matching event', candidate)),
  ].join('\n');
}

/**
 * Extract one ConceptGroup per distinct canonical event term in the query.
 * Plural and synonym forms collapse to the same group via SYNONYM_TO_CANONICAL;
 * unknown terms become singleton groups.
 */
function extractEventConceptGroups(query: string): ConceptGroup[] {
  const source = extractOrdinalClauses(query);
  const rawTerms = extractTemporalTerms(source);

  const seenCanonicals = new Set<string>();
  const groups: ConceptGroup[] = [];
  for (const term of rawTerms) {
    const canonical = SYNONYM_TO_CANONICAL.get(term);
    if (canonical) {
      if (!seenCanonicals.has(canonical)) {
        seenCanonicals.add(canonical);
        groups.push(EVENT_SYNONYMS[canonical]);
      }
    } else {
      groups.push([term]);
    }
  }
  return groups;
}

function extractOrdinalClauses(query: string): string {
  const pieces = query.toLowerCase().split(/\b(?:first|second)\b/).slice(1);
  return pieces.join(' ') || query;
}

function extractGeneralTemporalTerms(query: string): string[] {
  return extractTemporalTerms(query);
}

function extractTemporalTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/\b([a-z]+)'s\b/g, '$1')
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= QUERY_TERM_MIN_LENGTH)
    .filter((term) => !QUERY_EVENT_STOP_WORDS.has(term));
}

function extractQuerySubjects(query: string): string[] {
  const subjectMatches = query.match(/\b[A-Z][a-z]+(?:'s)?\b/g) ?? [];
  const normalized = subjectMatches
    .map((subject) => subject.replace(/'s$/i, ''))
    .filter((subject) => !QUERY_SUBJECT_STOP_WORDS.has(subject))
    .filter((subject) => !MONTH_NAMES.has(subject));
  return [...new Set(normalized.map((subject) => subject.toLowerCase()))];
}

function findEndpointCandidates(
  memories: SearchResult[],
  conceptGroups: ConceptGroup[],
): EndpointCandidate[] {
  return memories
    .map((memory) => scoreEndpointCandidate(memory, conceptGroups))
    .filter((candidate): candidate is EndpointCandidate => candidate !== null)
    .sort((left, right) => left.memory.created_at.getTime() - right.memory.created_at.getTime());
}

function selectGeneralTemporalCandidates(
  memories: SearchResult[],
  queryTerms: string[],
  subjectTerms: string[],
  conceptGroups: ConceptGroup[],
): TemporalCandidate[] {
  return memories
    .map((memory) => scoreGeneralTemporalCandidate(memory, queryTerms, subjectTerms, conceptGroups))
    .filter((candidate): candidate is TemporalCandidate => candidate !== null)
    .sort((left, right) => compareGeneralTemporalCandidates(left, right))
    .slice(0, GENERAL_TEMPORAL_LIMIT);
}

/**
 * A candidate qualifies only if every concept group in the query has at
 * least one synonym present in the memory's content. Score is the number
 * of groups matched (ties broken by date order downstream).
 */
function scoreEndpointCandidate(
  memory: SearchResult,
  conceptGroups: ConceptGroup[],
): EndpointCandidate | null {
  const content = memory.content.toLowerCase();
  const matched = conceptGroups.filter((group) => group.some((synonym) => content.includes(synonym))).length;
  if (matched < conceptGroups.length) return null;
  return { dateKey: formatDateLabel(memory.created_at), memory, score: matched };
}

function scoreGeneralTemporalCandidate(
  memory: SearchResult,
  queryTerms: string[],
  subjectTerms: string[],
  conceptGroups: ConceptGroup[],
): TemporalCandidate | null {
  const lowerContent = memory.content.toLowerCase();
  const tokenSet = buildNormalizedTokenSet(memory.content);
  const termMatches = queryTerms.reduce(
    (total, term) => total + (tokenSet.has(normalizeTemporalTerm(term)) ? 1 : 0),
    0,
  );
  const subjectMatches = countSubjectMatches(lowerContent, subjectTerms);
  const eventGroupMatches = countMatchedEventGroups(lowerContent, conceptGroups);
  const isPlanningLike = containsPlanningMarker(lowerContent);
  const score = termMatches
    + (subjectMatches * SUBJECT_MATCH_BONUS)
    + (eventGroupMatches * EVENT_GROUP_MATCH_BONUS)
    - (isPlanningLike ? PLANNING_PENALTY : 0);
  if (score <= 0) return null;
  return {
    dateKey: formatDateLabel(memory.created_at),
    memory,
    score,
    subjectMatches,
    eventGroupMatches,
    isPlanningLike,
  };
}

function compareGeneralTemporalCandidates(
  left: TemporalCandidate,
  right: TemporalCandidate,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.eventGroupMatches !== right.eventGroupMatches) {
    return right.eventGroupMatches - left.eventGroupMatches;
  }
  if (left.subjectMatches !== right.subjectMatches) {
    return right.subjectMatches - left.subjectMatches;
  }
  if (left.isPlanningLike !== right.isPlanningLike) {
    return left.isPlanningLike ? 1 : -1;
  }
  return left.memory.created_at.getTime() - right.memory.created_at.getTime();
}

function buildNormalizedTokenSet(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .replace(/\b([a-z]+)'s\b/g, '$1')
      .replace(/[^a-z0-9'\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= QUERY_TERM_MIN_LENGTH)
      .map(normalizeTemporalTerm),
  );
}

function normalizeTemporalTerm(term: string): string {
  const irregular = IRREGULAR_NORMALIZATION[term];
  if (irregular) return irregular;
  for (const suffix of STEM_SUFFIXES) {
    if (term.length > suffix.length + 2 && term.endsWith(suffix)) {
      return term.slice(0, -suffix.length);
    }
  }
  return term;
}

function buildGeneralDurationEndpointLines(
  candidates: TemporalCandidate[],
  query: string,
): string[] {
  if (!DURATION_QUERY.test(query.toLowerCase())) return [];
  const selected = selectDurationEndpoints(candidates);
  if (selected.length < DURATION_ENDPOINT_LIMIT) return [];
  return [
    formatEndpointLine('earliest matching event', selected[0]),
    formatEndpointLine('latest matching event', selected[1]),
    `- elapsed between endpoints: ${formatDuration(diffDays(
      selected[0].memory.created_at,
      selected[1].memory.created_at,
    ))}`,
  ];
}

function selectDurationEndpoints(candidates: TemporalCandidate[]): TemporalCandidate[] {
  const stableCandidates = preferCompletedCandidates(candidates);
  const byDate = new Map<string, TemporalCandidate>();
  for (const candidate of stableCandidates) {
    const existing = byDate.get(candidate.dateKey);
    if (!existing || compareGeneralTemporalCandidates(candidate, existing) < 0) {
      byDate.set(candidate.dateKey, candidate);
    }
  }
  const distinct = [...byDate.values()].sort((left, right) =>
    left.memory.created_at.getTime() - right.memory.created_at.getTime(),
  );
  if (distinct.length < DURATION_ENDPOINT_LIMIT) return [];
  return [distinct[0], distinct[distinct.length - 1]];
}

function preferCompletedCandidates(candidates: TemporalCandidate[]): TemporalCandidate[] {
  const completed = candidates.filter((candidate) => !candidate.isPlanningLike);
  return completed.length >= DURATION_ENDPOINT_LIMIT ? completed : candidates;
}

function countSubjectMatches(content: string, subjectTerms: string[]): number {
  return subjectTerms.reduce(
    (total, subject) => total + (content.includes(subject) ? 1 : 0),
    0,
  );
}

function countMatchedEventGroups(content: string, conceptGroups: ConceptGroup[]): number {
  return conceptGroups.filter((group) => group.some((synonym) => content.includes(synonym))).length;
}

function containsPlanningMarker(content: string): boolean {
  return PLANNING_MARKERS.some((marker) => content.includes(marker));
}

function selectDistinctDateEndpoints(candidates: EndpointCandidate[]): EndpointCandidate[] {
  const byDate = new Map<string, EndpointCandidate>();
  for (const candidate of candidates) {
    const existing = byDate.get(candidate.dateKey);
    if (!existing || candidate.score > existing.score) byDate.set(candidate.dateKey, candidate);
  }
  return [...byDate.values()].sort((left, right) =>
    left.memory.created_at.getTime() - right.memory.created_at.getTime(),
  ).slice(0, 2);
}

function formatEndpointLine(label: string, candidate: EndpointCandidate): string {
  return `- ${label}: ${candidate.dateKey} — ${truncateEvidence(candidate.memory.content)}`;
}

function truncateEvidence(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= EVIDENCE_MAX_CHARS) return normalized;
  return `${normalized.slice(0, EVIDENCE_MAX_CHARS - 3)}...`;
}

function diffDays(first: Date, second: Date): number {
  return Math.round((second.getTime() - first.getTime()) / 86400000);
}
