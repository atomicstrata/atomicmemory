/**
 * Deterministic enrichment for extracted entities and relations.
 * Complements LLM extraction by adding a stable self entity plus high-signal
 * relation/entity patterns that the model often omits in temporal comparison
 * facts and advisor/timeline facts.
 */

import type { ExtractedEntity, ExtractedFact, ExtractedRelation } from './extraction.js';
import { dedupeEntities } from './entity-dedup.js';
import { inferEventAnchorFacts } from './event-anchor-facts.js';

const SELF_ENTITY: ExtractedEntity = { name: 'User', type: 'person' };
const SELF_MARKERS = ['user ', 'user\'s', 'i ', 'i\'m', 'i’ve', 'i have', 'my '];
const PREFERENCE_MARKERS = ['prefer', 'favorite', 'love', 'like', "can't go back"];
const USES_MARKERS = ['using', 'use', 'added', 'implemented', 'integration', 'switched from', 'switch from', 'switch to'];
const WORKS_ON_MARKERS = ['building', 'working on', 'started', 'created', 'built', 'update on'];
const KNOWS_MARKERS = ['advisor', 'career advice from', 'supportive', 'recommendation letter', 'recommended by'];
const STUDIES_MARKERS = ['focus on', 'studying', 'research', 'paper on'];

const TOOL_NAMES = new Set([
  'React',
  'TypeScript',
  'Vite',
  'Tailwind CSS',
  'Supabase',
  'Plaid',
  'tRPC',
  'React Query',
  'TanStack Virtual',
  'Vercel',
  'GRE',
  'EMNLP 2025',
  'ACL 2026',
]);

const ORGANIZATION_NAMES = new Set([
  'OpenAI',
  'Anthropic',
  'Google',
  'Meta',
  'Microsoft Research',
  'Stanford',
  'MIT',
  'CMU',
  'UC Berkeley',
]);

const CANONICAL_ENTITY_NAMES: Record<string, string> = {
  msr: 'Microsoft Research',
};

export function enrichExtractedFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const enriched = facts.flatMap((fact) => {
    const baseFact = enrichExtractedFact(fact);
    return [baseFact, ...inferEventAnchorFacts(baseFact)];
  });
  return dedupeFacts(enriched);
}

export function enrichExtractedFact(fact: ExtractedFact): ExtractedFact {
  const entities = dedupeEntities([
    ...fact.entities,
    ...inferKeywordEntities(fact),
    ...inferFactEntities(fact.fact),
  ]);

  const withSelf = shouldAddSelfEntity(fact.fact) ? dedupeEntities([SELF_ENTITY, ...entities]) : entities;
  const relations = dedupeRelations([
    ...fact.relations,
    ...inferRelations(fact.fact, withSelf),
  ]);

  return { ...fact, entities: withSelf, relations };
}

function shouldAddSelfEntity(text: string): boolean {
  const lower = text.toLowerCase();
  return SELF_MARKERS.some((marker) => lower.includes(marker));
}

function inferKeywordEntities(fact: ExtractedFact): ExtractedEntity[] {
  return fact.keywords
    .map((keyword) => inferEntityFromToken(keyword, fact.fact))
    .filter((entity): entity is ExtractedEntity => entity !== null);
}

function inferFactEntities(text: string): ExtractedEntity[] {
  const matches: ExtractedEntity[] = [];
  const personMatches = text.match(/\bDr\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) ?? [];
  for (const match of personMatches) {
    matches.push({ name: match.trim(), type: 'person' });
  }

  const projectMatches = text.match(/\b(?:the\s+)?([A-Za-z0-9.-]+(?:\s+[A-Za-z0-9.-]+){0,2}\s+(?:tracker|project|app|repo|dashboard|paper))\b/gi) ?? [];
  for (const match of projectMatches) {
    matches.push({ name: normalizeEntityDisplay(match), type: 'project' });
  }

  const orgMatches = text.match(/\b(?:Microsoft Research|UC Berkeley|Stanford|MIT|CMU|Google|Meta|OpenAI|Anthropic)\b/g) ?? [];
  for (const match of orgMatches) {
    matches.push({ name: normalizeEntityDisplay(match), type: 'organization' });
  }

  const titleMatches = [
    ...extractPatternCaptures(text, /\b(?:recommended|reading|book(?:\s+\w+){0,2}\s+was|favorite childhood book was|favorite book was|song|songs|listening to|fan of)\s+("?)([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+)*)\1/g),
    ...extractPatternCaptures(text, /["“”]([^"“”]{2,80})["“”]/g),
  ];
  for (const match of titleMatches) {
    matches.push({ name: normalizeEntityDisplay(match), type: 'concept' });
  }

  const petMatches = extractPatternCaptures(text, /\b([A-Z][a-z]+)\s+(?:hid|hides|found|finds|was|is)\s+(?:his|her|a|an|the)\b/g);
  for (const match of petMatches) {
    matches.push({ name: normalizeEntityDisplay(match), type: 'concept' });
  }

  return matches;
}

function inferEntityFromToken(token: string, factText: string): ExtractedEntity | null {
  const cleaned = normalizeEntityDisplay(token);
  const canonical = CANONICAL_ENTITY_NAMES[cleaned.toLowerCase()] ?? cleaned;

  if (TOOL_NAMES.has(canonical)) {
    return { name: canonical, type: 'tool' };
  }
  if (ORGANIZATION_NAMES.has(canonical)) {
    return { name: canonical, type: 'organization' };
  }
  if (/^Dr\.\s+[A-Z]/.test(canonical)) {
    return { name: canonical, type: 'person' };
  }
  if (looksLikeProject(canonical, factText)) {
    return { name: canonical, type: 'project' };
  }
  if (looksLikeConcept(canonical, factText)) {
    return { name: canonical, type: 'concept' };
  }
  return null;
}

function inferRelations(text: string, entities: ExtractedEntity[]): ExtractedRelation[] {
  const lower = text.toLowerCase();
  const relations: ExtractedRelation[] = [];
  const grouped = groupEntitiesByType(entities);

  if (grouped.self) {
    inferSelfRelations(lower, grouped.self.name, grouped, relations);
  }
  inferCrossEntityRelations(lower, grouped, relations);

  return relations.filter((relation) => relation.source !== relation.target);
}

interface GroupedEntities {
  self: ExtractedEntity | undefined;
  people: ExtractedEntity[];
  tools: ExtractedEntity[];
  projects: ExtractedEntity[];
  orgs: ExtractedEntity[];
  concepts: ExtractedEntity[];
}

/** Partition entities into typed groups for relation inference. */
function groupEntitiesByType(entities: ExtractedEntity[]): GroupedEntities {
  return {
    self: entities.find((e) => e.name === SELF_ENTITY.name),
    people: entities.filter((e) => e.type === 'person' && e.name !== SELF_ENTITY.name),
    tools: entities.filter((e) => e.type === 'tool'),
    projects: entities.filter((e) => e.type === 'project'),
    orgs: entities.filter((e) => e.type === 'organization'),
    concepts: entities.filter((e) => e.type === 'concept'),
  };
}

/** Infer relations from the self entity to other entities based on text markers. */
function inferSelfRelations(
  lower: string,
  selfName: string,
  grouped: GroupedEntities,
  relations: ExtractedRelation[],
): void {
  const markerRules: Array<{ markers: string[]; targets: ExtractedEntity[]; type: ExtractedRelation['type'] }> = [
    { markers: USES_MARKERS, targets: grouped.tools, type: 'uses' },
    { markers: WORKS_ON_MARKERS, targets: grouped.projects, type: 'works_on' },
    { markers: PREFERENCE_MARKERS, targets: grouped.tools, type: 'prefers' },
    { markers: KNOWS_MARKERS, targets: grouped.people, type: 'knows' },
    { markers: STUDIES_MARKERS, targets: grouped.concepts, type: 'studies' },
  ];
  for (const rule of markerRules) {
    if (containsAny(lower, rule.markers)) {
      for (const target of rule.targets) {
        relations.push({ source: selfName, target: target.name, type: rule.type });
      }
    }
  }
  if (/\bwork(?:ing)?(?:\s+as\s+.+?)?\s+at\b/.test(lower)) {
    for (const org of grouped.orgs) {
      relations.push({ source: selfName, target: org.name, type: 'works_at' });
    }
  }
}

/** Infer cross-entity relations (person-org, project-tool). */
function inferCrossEntityRelations(
  lower: string,
  grouped: GroupedEntities,
  relations: ExtractedRelation[],
): void {
  if (matchesPersonAtOrg(lower, grouped)) {
    pushCrossProduct(grouped.people, grouped.orgs, 'works_at', relations);
  }
  if (matchesProjectUsesTool(lower, grouped)) {
    pushCrossProduct(grouped.projects, grouped.tools, 'uses', relations);
  }
}

function matchesPersonAtOrg(lower: string, grouped: GroupedEntities): boolean {
  return grouped.people.length > 0 && grouped.orgs.length > 0 && /\bat\b/.test(lower);
}

function matchesProjectUsesTool(lower: string, grouped: GroupedEntities): boolean {
  return grouped.projects.length > 0 && grouped.tools.length > 0 && containsAny(lower, USES_MARKERS);
}

function pushCrossProduct(
  sources: ExtractedEntity[],
  targets: ExtractedEntity[],
  type: ExtractedRelation['type'],
  relations: ExtractedRelation[],
): void {
  for (const source of sources) {
    for (const target of targets) {
      relations.push({ source: source.name, target: target.name, type });
    }
  }
}

function containsAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function looksLikeProject(token: string, factText: string): boolean {
  const lowerToken = token.toLowerCase();
  return /\b(tracker|project|app|repo|dashboard|paper)\b/.test(lowerToken)
    || factText.toLowerCase().includes(`the ${lowerToken}`)
    || lowerToken === 'dotctl';
}

function looksLikeConcept(token: string, factText: string): boolean {
  const lowerToken = token.toLowerCase();
  return /\b(llms?|machine translation|transfer learning|low-resource|phd|languages?)\b/.test(lowerToken)
    || /\b(focus on|research|paper on|studying)\b/.test(factText.toLowerCase());
}

function normalizeEntityDisplay(token: string): string {
  return token.trim().replace(/^[Tt]he\s+/, '').replace(/[. ]+$/, '');
}

function extractPatternCaptures(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const captured = match[2] ?? match[1];
    if (captured) {
      matches.push(captured.trim());
    }
  }
  return matches;
}

function dedupeFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const unique = new Map<string, ExtractedFact>();
  for (const fact of facts) {
    unique.set(fact.fact.toLowerCase().replace(/\s+/g, ' ').trim(), fact);
  }
  return [...unique.values()];
}

function dedupeRelations(relations: ExtractedRelation[]): ExtractedRelation[] {
  const unique = new Map<string, ExtractedRelation>();
  for (const relation of relations) {
    unique.set(`${relation.source.toLowerCase()}:${relation.type}:${relation.target.toLowerCase()}`, relation);
  }
  return [...unique.values()];
}
