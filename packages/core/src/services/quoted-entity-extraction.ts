/**
 * Deterministic quoted-entity extraction for exact titles and event names.
 *
 * This supplements LLM extraction when exact quoted titles or performers are
 * text-visible but the generated fact weakens the relation. It intentionally
 * does not infer image-only text or unseen metadata.
 */

import type { ExtractedEntity, ExtractedFact } from './extraction.js';

const SESSION_DATE_PATTERN = /^\[Session date:\s*(\d{4})-(\d{2})-(\d{2})\]/im;
const SPEAKER_LINE_PATTERN = /^([A-Za-z][A-Za-z0-9' -]{1,40}):\s*(.+)$/;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface Turn {
  speaker: string;
  text: string;
}

export function mergeQuotedEntityFacts(
  existingFacts: ExtractedFact[],
  conversationText: string,
): ExtractedFact[] {
  const supplemental = extractQuotedEntityFacts(conversationText);
  if (supplemental.length === 0) return existingFacts;

  const byFact = new Map(existingFacts.map((fact) => [normalize(fact.fact), fact]));
  for (const fact of supplemental) {
    if (!byFact.has(normalize(fact.fact))) {
      byFact.set(normalize(fact.fact), fact);
    }
  }
  return [...byFact.values()];
}

export function extractQuotedEntityFacts(conversationText: string): ExtractedFact[] {
  const sessionDate = parseSessionDate(conversationText);
  const facts = parseTurns(conversationText)
    .flatMap((turn) => extractFactsFromTurn(turn, sessionDate));
  return dedupeFacts(facts);
}

function extractFactsFromTurn(turn: Turn, sessionDate: string | null): ExtractedFact[] {
  return [
    ...extractBookTitleFacts(turn, sessionDate),
    ...extractPerformerEventFacts(turn, sessionDate),
    ...extractRecommendationLetterFacts(turn, sessionDate),
  ];
}

function extractBookTitleFacts(turn: Turn, sessionDate: string | null): ExtractedFact[] {
  if (!/\b(?:book|books|read|reading)\b/i.test(turn.text)) return [];
  return extractQuotedValues(turn.text).map((title) => {
    const isFavorite = /\bfavou?rite\b/i.test(turn.text);
    const relation = isFavorite ? 'favorite childhood book was' : 'read';
    const fact = `${subjectPrefix(sessionDate, turn.speaker)} ${relation} "${title}".`;
    return buildFact(fact, title, 'concept', ['book', title], isFavorite ? 'preference' : 'knowledge');
  });
}

function extractPerformerEventFacts(turn: Turn, sessionDate: string | null): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const leadingQuoted = turn.text.match(/^\s*["'“‘]([^"'”’]{2,80})["'”’]\s*[-:]/);
  if (leadingQuoted && hasPerformanceSignal(turn.text)) {
    const performer = leadingQuoted[1]!.trim();
    facts.push(buildPerformerFact(sessionDate, turn.speaker, performer));
  }

  for (const performer of extractNamedConcertPerformers(turn.text)) {
    facts.push(buildPerformerFact(sessionDate, turn.speaker, performer));
  }
  return facts;
}

function extractRecommendationLetterFacts(turn: Turn, sessionDate: string | null): ExtractedFact[] {
  if (!/\brecommendation letter\b/i.test(turn.text)) return [];
  if (!/\b(?:writing|write|wrote|agreed to write)\b/i.test(turn.text)) return [];

  const writer = extractRecommendationWriter(turn.text);
  if (!writer) return [];

  return [
    buildFact(
      `${subjectPrefix(sessionDate, writer)} is writing ${possessiveSubject(turn.speaker)} main recommendation letter.`,
      writer,
      'person',
      ['recommendation letter', writer],
      'knowledge',
    ),
  ];
}

function extractRecommendationWriter(text: string): string | null {
  const direct = text.match(
    /\b(?<writer>Dr\.?\s+[A-Z][A-Za-z'’.-]+|[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})\s+(?:is|'s|will be|agreed to)\s+(?:writing|write)\s+(?:my|their|the user's)?\s*(?:main\s+)?recommendation letter\b/i,
  );
  if (direct?.groups?.writer) return normalizePersonName(direct.groups.writer);

  const pronoun = text.match(
    /\b(?<writer>Dr\.?\s+[A-Z][A-Za-z'’.-]+|[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})\b[^.]{0,120}\.\s*(?:she|he|they)\s*(?:'s| is| are| will be)?\s+(?:writing|write)\s+(?:my|their|the user's)?\s*(?:main\s+)?recommendation letter\b/i,
  );
  return pronoun?.groups?.writer ? normalizePersonName(pronoun.groups.writer) : null;
}

function buildPerformerFact(
  sessionDate: string | null,
  speaker: string,
  performer: string,
): ExtractedFact {
  return buildFact(
    `${subjectPrefix(sessionDate, speaker)} saw "${performer}" perform music.`,
    performer,
    'concept',
    ['artist', 'band', 'music', performer],
    'knowledge',
  );
}

function extractNamedConcertPerformers(text: string): string[] {
  const performers: string[] = [];
  const patterns = [
    /\bat\s+(?:a\s+)?([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,4})\s+concert\b/g,
    /\bconcert\s+(?:featuring|with)\s+([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,4})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      performers.push(stripTrailingWords(match[1]!));
    }
  }
  return performers.filter(Boolean);
}

function hasPerformanceSignal(text: string): boolean {
  return /\b(?:played|playing|performed|performing|concert|show|stage|song|songs|dancing|singing)\b/i.test(text);
}

function extractQuotedValues(text: string): string[] {
  const values: string[] = [];
  collectQuotedValues(values, text, /"([^"]{2,80})"/g);
  collectQuotedValues(values, text, /“([^”]{2,80})”/g);
  collectQuotedValues(values, text, /'([^']{2,80})'/g);
  collectQuotedValues(values, text, /‘([^’]{2,80})’/g);
  return values;
}

function collectQuotedValues(values: string[], text: string, pattern: RegExp): void {
  for (const match of text.matchAll(pattern)) {
    values.push(match[1]!.trim());
  }
}

function parseTurns(conversationText: string): Turn[] {
  return conversationText
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.match(SPEAKER_LINE_PATTERN))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ speaker: match[1]!, text: match[2]! }));
}

function parseSessionDate(conversationText: string): string | null {
  const match = conversationText.match(SESSION_DATE_PATTERN);
  if (!match) return null;
  const month = MONTH_NAMES[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])} ${match[1]}` : null;
}

function subjectPrefix(sessionDate: string | null, speaker: string): string {
  const subject = speaker || 'user';
  return sessionDate ? `As of ${sessionDate}, ${subject}` : subject;
}

function possessiveSubject(speaker: string): string {
  return /^user$/i.test(speaker) ? "user's" : `${speaker}'s`;
}

function buildFact(
  fact: string,
  entityName: string,
  entityType: ExtractedEntity['type'],
  keywords: string[],
  type: ExtractedFact['type'],
): ExtractedFact {
  return {
    fact,
    headline: fact.split(/\s+/).slice(0, 10).join(' '),
    importance: 0.7,
    type,
    keywords,
    entities: [{ name: entityName, type: entityType }],
    relations: [],
  };
}

function stripTrailingWords(text: string): string {
  return text.replace(/\s+(?:last|yesterday|today|tomorrow)$/i, '').trim();
}

function normalizePersonName(text: string): string {
  return text
    .replace(/^(?:my|the user's|user's)\s+(?:advisor|mentor|professor)\s+/i, '')
    .replace(/\bDr\s+/i, 'Dr. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const unique = new Map(facts.map((fact) => [normalize(fact.fact), fact]));
  return [...unique.values()];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
