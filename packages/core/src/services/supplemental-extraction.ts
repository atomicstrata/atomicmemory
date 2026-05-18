/**
 * Supplemental extraction coverage for high-signal deterministic facts.
 * Merges quick extractor output into the main LLM extraction result when the
 * supplemental fact adds missing entities, relations, or temporal detail.
 */

import type { ExtractedFact } from './extraction.js';
import { normalizeExtractedFacts } from './fact-normalization.js';
import { quickExtractFacts } from './quick-extraction.js';
import { containsRelativeTemporalPhrase } from './relative-temporal.js';

const LITERAL_DETAIL_PATTERN =
  /\b(?:necklace|book|books|song|songs|music|musicians|fan|painting|paintings|photo|poster|posters|library|store|decor|furniture|flooring|pet|pets|cat|cats|dog|dogs|guinea pig|turtle|turtles|snake|snakes|workshop|poetry reading|sign|slipper|bowl)\b/i;
const QUOTED_TEXT_PATTERN = /["“”][^"“”]{2,}["“”]/;
const TEMPORAL_DETAIL_PATTERN =
  /\b(last year|last month|last week|last [a-z]+|today|tomorrow|first|second|before|after|deadline|deadlines|timeline|relative to|months later|weeks later|few days ago|for \d+ years?|for three years?|for two years?|for four years?|for five years?)\b/i;
const EVENT_DETAIL_PATTERN =
  /\b(?:accepted|interview|internship|mentor(?:ed|ing)?|network(?:ing)?|social media|competition|investor(?:s)?|fashion editors|analytics tools|video presentation|website|collaborat(?:e|ion)|dance class|Shia Labeouf|trip|travel(?:ed|ling)?|retreat|phuket|doctor|doc|check-up|appointment|blog|car mods?|restor(?:e|ed|ing|ation))\b/i;

export function mergeSupplementalFacts(
  primaryFacts: ExtractedFact[],
  conversationText: string,
): ExtractedFact[] {
  const merged = [...primaryFacts];
  const supplementalFacts = normalizeExtractedFacts(quickExtractFacts(conversationText));

  for (const fact of supplementalFacts) {
    const upgradeIndex = findUpgradeableFactIndex(merged, fact);
    if (upgradeIndex >= 0) {
      merged[upgradeIndex] = fact;
      continue;
    }
    if (shouldIncludeSupplementalFact(merged, fact)) {
      merged.push(fact);
    }
  }

  return dedupeByNormalizedFact(merged);
}

interface CandidateDetailFlags {
  temporal: boolean;
  literal: boolean;
  event: boolean;
}

function detectCandidateDetailFlags(candidate: ExtractedFact): CandidateDetailFlags {
  return {
    temporal: hasRelativeTemporalDetail(candidate.fact),
    literal: hasLiteralDetail(candidate.fact),
    event: hasEventDetail(candidate.fact),
  };
}

function hasAnyDetail(flags: CandidateDetailFlags): boolean {
  return flags.temporal || flags.literal || flags.event;
}

/**
 * When the candidate's coverage shape already exists in the existing set, only
 * keep it if its detail flags add something none of the shape-matched facts
 * carry yet. Detail flags are checked in priority order (temporal > literal >
 * event) — the first flag the candidate has determines which existing detail
 * predicate must be absent across all shape matches.
 */
function shouldKeepOverShapeMatches(
  shapeMatches: ExtractedFact[],
  flags: CandidateDetailFlags,
): boolean {
  if (!hasAnyDetail(flags)) return false;
  if (flags.temporal) return shapeMatches.every((fact) => !hasRelativeTemporalDetail(fact.fact));
  if (flags.literal) return shapeMatches.every((fact) => !hasLiteralDetail(fact.fact));
  if (flags.event) return shapeMatches.every((fact) => !hasEventDetail(fact.fact));
  return false;
}

function shouldIncludeSupplementalFact(
  existingFacts: ExtractedFact[],
  candidate: ExtractedFact,
): boolean {
  const normalizedFact = normalizeFact(candidate.fact);
  if (existingFacts.some((fact) => normalizeFact(fact.fact) === normalizedFact)) {
    return false;
  }

  const flags = detectCandidateDetailFlags(candidate);
  const candidateEntities = listNonUserEntities(candidate);
  if (candidateEntities.length === 0 && !hasAnyDetail(flags)) {
    return false;
  }

  const candidateShape = buildCoverageShape(candidate);
  const shapeMatches = existingFacts.filter(
    (fact) => buildCoverageShape(fact) === candidateShape,
  );
  if (shapeMatches.length === 0) {
    return true;
  }
  return shouldKeepOverShapeMatches(shapeMatches, flags);
}

function findUpgradeableFactIndex(
  existingFacts: ExtractedFact[],
  candidate: ExtractedFact,
): number {
  const candidateEntities = new Set(listNonUserEntities(candidate));
  const candidateRelations = new Set(candidate.relations.map((relation) => relation.type));
  const candidateAddsTemporalDetail = hasRelativeTemporalDetail(candidate.fact);
  const candidateAddsLiteralDetail = hasLiteralDetail(candidate.fact);
  const candidateAddsEventDetail = hasEventDetail(candidate.fact);

  return existingFacts.findIndex((fact) => {
    const existingEntities = listNonUserEntities(fact);
    if (existingEntities.length === 0 || candidateEntities.size <= existingEntities.length) {
      return false;
    }

    const entitiesCovered = existingEntities.every((entity) => candidateEntities.has(entity));
    if (!entitiesCovered) {
      return false;
    }

    const existingRelations = fact.relations.map((relation) => relation.type);
    const relationsCovered = existingRelations.every((relation) => candidateRelations.has(relation));
    if (!relationsCovered) {
      return false;
    }

    if (candidate.fact.length <= fact.fact.length + 10) {
      return false;
    }

    return candidateAddsTemporalDetail
      || candidateAddsLiteralDetail
      || candidateAddsEventDetail
      || !hasRelativeTemporalDetail(fact.fact);
  });
}

function buildCoverageShape(fact: ExtractedFact): string {
  const entities = listNonUserEntities(fact).join('|');
  const relations = fact.relations.map((relation) => relation.type).sort().join('|');
  return `${entities}::${relations}`;
}

function listNonUserEntities(fact: ExtractedFact): string[] {
  return [...new Set(
    fact.entities
      .map((entity) => entity.name.trim().toLowerCase())
      .filter((name) => name && name !== 'user'),
  )].sort();
}

function hasRelativeTemporalDetail(text: string): boolean {
  return TEMPORAL_DETAIL_PATTERN.test(text) || containsRelativeTemporalPhrase(text);
}

function hasLiteralDetail(text: string): boolean {
  return LITERAL_DETAIL_PATTERN.test(text) || QUOTED_TEXT_PATTERN.test(text);
}

function hasEventDetail(text: string): boolean {
  return EVENT_DETAIL_PATTERN.test(text);
}

function dedupeByNormalizedFact(facts: ExtractedFact[]): ExtractedFact[] {
  const unique = new Map<string, ExtractedFact>();
  for (const fact of facts) {
    unique.set(normalizeFact(fact.fact), fact);
  }
  return [...unique.values()];
}

function normalizeFact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
