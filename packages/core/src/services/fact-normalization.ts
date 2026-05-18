/**
 * Deterministic post-processing for LLM-extracted facts.
 * Preserves atomic memory coverage by splitting common multi-clause patterns
 * that the extraction prompt still tends to bundle together.
 */

export interface NormalizedFactInput {
  fact: string;
  importance: number;
  type: string;
  keywords: string[];
}

const RECOMMENDATION_MARKERS = [
  ', as recommended by ',
  ', recommended by ',
  ', as suggested by ',
  ', suggested by ',
];

export function normalizeExtractedFacts<T extends NormalizedFactInput>(facts: T[]): T[] {
  const expanded = facts.flatMap((fact) =>
    splitCompoundFact(fact)
      .flatMap(expandBecauseClause)
      .flatMap(normalizeLiteralAliasFacts),
  );
  return dedupeFacts(expanded);
}

function splitCompoundFact<T extends NormalizedFactInput>(fact: T): T[] {
  const recommendationSplit = splitRecommendationAttribution(fact);
  if (recommendationSplit) return recommendationSplit;
  const transitionSplit = splitStateTransitionFact(fact);
  if (transitionSplit) return transitionSplit;
  return [fact];
}

function splitRecommendationAttribution<T extends NormalizedFactInput>(fact: T): T[] | null {
  const marker = RECOMMENDATION_MARKERS.find((candidate) => fact.fact.includes(candidate));
  if (!marker) return null;

  const parts = fact.fact.split(marker);
  if (parts.length !== 2) return null;

  const mainFact = ensurePeriod(parts[0]);
  const recommender = normalizePerson(parts[1]);
  const recommendedObject = extractRecommendedObject(mainFact);

  if (!recommender || !recommendedObject) return null;

  const recommendationFact = `${extractTemporalPrefix(mainFact)}${recommender} recommended ${recommendedObject}.`;

  return [
    { ...fact, fact: mainFact },
    {
      ...fact,
      fact: recommendationFact,
      type: 'person',
      importance: clampImportance(Math.min(fact.importance, 0.5)),
      keywords: mergeKeywords(fact.keywords, [recommender]),
    },
  ];
}

function extractRecommendedObject(text: string): string | null {
  const withoutPrefix = stripTemporalPrefix(text);
  const patterns = [
    /^user is using (.+)$/i,
    /^user uses (.+)$/i,
    /^user plans to use (.+)$/i,
    /^user will use (.+)$/i,
    /^user is considering (.+)$/i,
    /^user chose (.+)$/i,
    /^user selected (.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = withoutPrefix.match(pattern);
    if (!match) continue;
    return match[1].trim().replace(/[. ]+$/, '');
  }

  return null;
}

function normalizePerson(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^(their|the)\s+/i, '')
    .replace(/^(colleague|friend|advisor|professor|team lead)\s+/i, '')
    .trim();

  return cleaned || null;
}

function splitStateTransitionFact<T extends NormalizedFactInput>(fact: T): T[] | null {
  return splitSwitchAwayFact(fact) ?? splitFromToStateChange(fact);
}

function splitSwitchAwayFact<T extends NormalizedFactInput>(fact: T): T[] | null {
  const match = fact.fact.match(/^(As of [^,]+,\s+)?(user|we)\s+switched away from (.+?) and (.+?)[. ]*$/i);
  if (!match) return null;

  const prefix = match[1] ?? '';
  const subject = match[2]!.toLowerCase();
  const previousState = stripTrailingPunctuation(match[3]!);
  const currentTarget = normalizeStateTarget(match[4]!);
  if (!currentTarget) return null;

  return [
    ...buildCurrentStateFacts(fact, prefix, subject, currentTarget),
    buildStateFact(
      fact,
      buildHistoricalStateText(prefix, subject, `switched away from ${previousState}`),
      0.45,
    ),
  ];
}

function splitFromToStateChange<T extends NormalizedFactInput>(fact: T): T[] | null {
  const match = fact.fact.match(
    /^(As of [^,]+,\s+)?(user|we|project)\s+(?:switched|migrated|moved|changed)\s+from (.+?) to (.+?)[. ]*$/i,
  );
  if (!match) return null;

  const prefix = match[1] ?? '';
  const subject = match[2]!.toLowerCase();
  const previousState = stripTrailingPunctuation(match[3]!);
  const currentTarget = normalizeStateTarget(match[4]!);
  if (!currentTarget) return null;

  return [
    ...buildCurrentStateFacts(fact, prefix, subject, currentTarget),
    buildStateFact(
      fact,
      buildHistoricalStateText(prefix, subject, `previously used ${previousState}`),
      0.45,
    ),
  ];
}

function buildStateFact<T extends NormalizedFactInput>(fact: T, text: string, importance?: number): T {
  return {
    ...fact,
    fact: text,
    importance: clampImportance(importance ?? fact.importance),
    keywords: filterKeywordsForFact(fact.keywords, text),
  };
}

function buildCurrentStateFacts<T extends NormalizedFactInput>(
  fact: T,
  prefix: string,
  subject: string,
  target: string,
): T[] {
  return [
    buildStateFact(fact, buildCurrentStateText(prefix, subject, target)),
    ...buildBackendAliasFacts(fact, prefix, subject, target),
  ];
}

function buildCurrentStateText(prefix: string, subject: string, target: string): string {
  const verb = subject === 'we' ? 'use' : 'uses';
  return formatStateSentence(prefix, `${subject} ${verb} ${target}`);
}

function buildHistoricalStateText(prefix: string, subject: string, clause: string): string {
  return formatStateSentence(prefix, `${subject} ${clause}`);
}

function formatStateSentence(prefix: string, statement: string): string {
  const sentence = `${prefix}${statement}`.trim();
  return ensurePeriod(prefix ? sentence : capitalize(sentence));
}

function normalizeStateTarget(raw: string): string | null {
  const clause = stripTrailingPunctuation(raw);
  const patterns = [
    /^(?:uses?|using|used|built|build|created|create|adopted|adopt|started using|start using|moved to|move to)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = clause.match(pattern);
    if (match) return stripTrailingPunctuation(match[1]!);
  }

  return clause || null;
}

function filterKeywordsForFact(keywords: string[], factText: string): string[] {
  const lowerFact = factText.toLowerCase();
  return keywords.filter((keyword) => lowerFact.includes(keyword.trim().toLowerCase()));
}

function buildBackendAliasFacts<T extends NormalizedFactInput>(
  fact: T,
  prefix: string,
  subject: string,
  target: string,
): T[] {
  if (!isMemoryBackendTarget(target)) return [];

  const statement = formatStateSentence(prefix, `${subject}'s current memory backend is ${target}`);
  return [{
    ...buildStateFact(fact, statement, Math.min(fact.importance, 0.7)),
    keywords: mergeKeywords(filterKeywordsForFact(fact.keywords, statement), ['memory backend', 'backend']),
  }];
}

function isMemoryBackendTarget(target: string): boolean {
  const lower = target.toLowerCase();
  return lower.includes('memory engine') || lower.includes('memory backend');
}

function expandBecauseClause<T extends NormalizedFactInput>(fact: T): T[] {
  const parts = splitBecauseClause(fact.fact);
  if (!parts) return [fact];
  return [buildPrimaryFact(fact, parts.primary), buildReasonFact(fact, parts.reason)];
}

function splitBecauseClause(text: string): { primary: string; reason: string } | null {
  const markerIndex = text.toLowerCase().indexOf(' because ');
  if (markerIndex === -1) return null;
  const primary = text.slice(0, markerIndex).trim().replace(/[. ]+$/, '');
  const reason = text.slice(markerIndex + ' because '.length).trim().replace(/[. ]+$/, '');
  if (!primary || !reason) return null;
  return { primary: `${primary}.`, reason };
}

function normalizeLiteralAliasFacts<T extends NormalizedFactInput>(fact: T): T[] {
  const namedPetFact = normalizeNamedPetFact(fact);
  return namedPetFact ? [namedPetFact] : [fact];
}

function normalizeNamedPetFact<T extends NormalizedFactInput>(fact: T): T | null {
  const match = fact.fact.match(/^(As of [^,]+,\s+)?([A-Z][A-Za-z'’.-]+),\s+(?:my|user's)\s+(guinea pig|dog|cat)\.?$/i);
  if (!match) return null;

  const temporalPrefix = match[1] ?? '';
  const petName = match[2];
  const petType = match[3].toLowerCase();
  return {
    ...fact,
    fact: `${temporalPrefix}user has a ${petType} named ${petName}.`,
    keywords: mergeKeywords(fact.keywords, [petName, petType]),
    type: 'person',
  };
}

function buildPrimaryFact<T extends NormalizedFactInput>(fact: T, primary: string): T {
  return { ...fact, fact: primary };
}

function buildReasonFact<T extends NormalizedFactInput>(fact: T, reason: string): T {
  return {
    ...fact,
    fact: `User reports that ${capitalize(reason)}.`,
    importance: clampImportance(Math.max(0.2, Math.min(0.4, fact.importance - 0.4))),
    type: 'knowledge',
  };
}

function dedupeFacts<T extends NormalizedFactInput>(facts: T[]): T[] {
  const unique = new Map<string, T>();
  for (const fact of facts) {
    unique.set(`${fact.type}:${fact.fact}`, fact);
  }
  return [...unique.values()];
}

function extractTemporalPrefix(text: string): string {
  if (!text.startsWith('As of ')) return '';
  const userIndex = text.toLowerCase().indexOf('user ');
  if (userIndex === -1) return '';
  return text.slice(0, userIndex);
}

function ensurePeriod(text: string): string {
  return text.trim().replace(/[. ]+$/, '') + '.';
}

function mergeKeywords(existing: string[], additions: string[]): string[] {
  return [...new Set([...existing, ...additions].map((keyword) => keyword.trim()).filter(Boolean))];
}

function clampImportance(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function stripTemporalPrefix(text: string): string {
  if (!text.startsWith('As of ')) return text;
  const userIndex = text.toLowerCase().indexOf('user ');
  if (userIndex === -1) return text;
  return text.slice(userIndex);
}

function stripTrailingPunctuation(text: string): string {
  return text.trim().replace(/[. ]+$/, '');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
