/**
 * Fast rule-based fact extraction for low-latency ingest (UC2).
 * Extracts facts from conversation text using pattern matching and simple
 * NER — no LLM calls. Produces ExtractedFact[] compatible with the full
 * consensus pipeline.
 *
 * Design: User turns are analyzed for self-referential statements ("I", "my",
 * "we") that reveal preferences, facts, plans, or knowledge. Fact-bearing
 * assistant turns (containing named entities, specific data, structured
 * content) are also extracted. Generic assistant chatter is filtered out.
 *
 * Trade-offs vs LLM extraction:
 * - Speed: <50ms vs 2-22s
 * - Quality: Captures explicit statements only (no inference, no summarization)
 * - Entity extraction: Basic NER plus deterministic enrichment
 * - Relation extraction: deterministic post-processing for high-signal patterns
 */

import type { ExtractedFact, ExtractedEntity, ExtractedRelation } from './extraction.js';
import { enrichExtractedFacts } from './extraction-enrichment.js';
import { annotateRelativeTemporalText } from './relative-temporal.js';
import { isFactBearingAssistantTurn, isAssistantFactStatement } from './assistant-turn-filter.js';
import {
  ENTITY_PATTERNS,
  QUOTED_TEXT_PATTERN,
  LITERAL_DETAIL_PATTERN,
  EVENT_DETAIL_PATTERN,
  hasStandaloneEntity,
} from './content-detection.js';

const SESSION_DATE_PATTERN = /^\[Session date:\s*(\d{4})-(\d{2})-(\d{2})\]/i;
const EXPLICIT_ABSOLUTE_DATE_PATTERN =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*|\s+)\d{4}\b/i;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const SPEAKER_PREFIX_PATTERN = /^[A-Z][A-Za-z0-9' -]{1,40}:\s*/;
const IMPLICIT_FIRST_PERSON_EVENT_PATTERN =
  /^(?:started|starting|built|building|developed|developing|created|creating|launched|launching|opened|opening|accepted|receiv(?:ed|ing)|got|had|went|attended|visited|reading|posted|hosting|working|looking|planning|taking|took)\b/i;

/** Patterns that indicate a user is stating a fact about themselves. */
const FIRST_PERSON_PATTERNS = [
  /\bI\s+(?:am|was|have|had|use|used|like|liked|prefer|preferred|love|loved|hate|hated|need|needed|want|wanted|work|worked|live|lived|study|studied|started|finished|completed|built|created|made|bought|got|moved|joined|left|quit|switched|tried|learned|know|knew|think|thought|believe|believed|feel|felt|plan|planned|decided|chose|picked|signed|enrolled|attended|visited|went|add|added|implement|implemented|submit|submitted|receive|received|take|took|score|scored|launch|launched|apply|applied|consider|considered|advise|advised|recommend|recommended|call|called|focus|focused|support|supported|find|found|design|designed)\b/i,
  /\bmy\s+(?:name|job|role|team|company|project|favorite|preference|goal|plan|background|experience|hobby|family|wife|husband|partner|son|daughter|kid|dog|cat|address|email|phone|stack|setup|workflow|necklace|book|books|song|songs|painting|photo|poster|library|store|pet|pets|bowl)\b/i,
  /\bwe\s+(?:use|used|have|had|built|created|switched|moved|started|decided|chose|plan|are|were)\b/i,
  /\bI['']m\s+(?:a|an|the|from|based|working|building|using|looking|trying|planning|learning|studying|interested|responsible|currently)\b/i,
  /\bI['']ve\s+(?:been|had|used|tried|built|worked|lived|started|finished|switched|decided)\b/i,
  /\b(?:had|got)\s+(?:a\s+)?(?:check-up|doctor['’]?s appointment|doc['’]?s appointment)\b/i,
  /\bLet['’]?s\s+(?:create|collaborate|get together|make|work)\b/i,
  /\bI\s+should\b/i,
];

/** Patterns for specific fact types. */
const TYPE_PATTERNS: Array<{ pattern: RegExp; type: ExtractedFact['type'] }> = [
  { pattern: /\b(?:prefer|like|love|hate|favorite|rather|instead of)\b/i, type: 'preference' },
  { pattern: /\b(?:project|repo|codebase|app|service|deploy|release|sprint|ticket)\b/i, type: 'project' },
  { pattern: /\b(?:plan|planning|going to|will|schedule|deadline|target|goal|roadmap)\b/i, type: 'plan' },
  { pattern: /\b(?:colleague|team|manager|boss|friend|family|wife|husband|partner|mentor)\b/i, type: 'person' },
];

interface TurnEntry {
  speaker: string | null;
  text: string;
  source: 'user' | 'assistant';
}

interface TurnState {
  currentTurn: string;
  currentSpeaker: string | null;
  currentSource: 'user' | 'assistant';
}

/**
 * Split conversation into turns, returning user turns and fact-bearing
 * assistant turns. Generic assistant chatter (acknowledgments, clarifying
 * questions, meta-commentary) is filtered out.
 */
function extractFactBearingTurns(text: string): TurnEntry[] {
  const lines = text.split('\n');
  const turns: TurnEntry[] = [];
  const state: TurnState = { currentTurn: '', currentSpeaker: null, currentSource: 'user' };

  for (const line of lines) {
    applyTurnLine(turns, state, line.trim());
  }
  pushTurn(turns, state.currentTurn, state.currentSpeaker, state.currentSource);

  // If no turn markers found, treat entire text as user input
  if (turns.length === 0 && text.trim()) {
    turns.push({ speaker: null, text: text.trim(), source: 'user' });
  }

  return turns;
}

function applyTurnLine(turns: TurnEntry[], state: TurnState, trimmed: string): void {
  if (SESSION_DATE_PATTERN.test(trimmed)) return;
  const speakerTurn = parseSpeakerTurn(trimmed);
  if (!speakerTurn) {
    state.currentTurn += '\n' + trimmed;
    return;
  }

  pushTurn(turns, state.currentTurn, state.currentSpeaker, state.currentSource);
  state.currentTurn = speakerTurn.text;
  state.currentSpeaker = speakerTurn.speaker;
  state.currentSource = speakerTurn.source;
}

function parseSpeakerTurn(trimmed: string): TurnEntry | null {
  if (/^(?:User|Human|Me):/i.test(trimmed)) {
    return { speaker: null, text: trimmed.replace(/^(?:User|Human|Me):\s*/i, ''), source: 'user' };
  }
  if (/^(?:Assistant|AI|Bot|Claude|ChatGPT|GPT):/i.test(trimmed)) {
    return { speaker: null, text: trimmed.replace(/^(?:Assistant|AI|Bot|Claude|ChatGPT|GPT):\s*/i, ''), source: 'assistant' };
  }
  if (!SPEAKER_PREFIX_PATTERN.test(trimmed)) return null;
  return {
    speaker: trimmed.match(/^([A-Z][A-Za-z0-9' -]{1,40}):/)?.[1] ?? null,
    text: trimmed,
    source: 'user',
  };
}

function pushTurn(
  turns: TurnEntry[],
  text: string,
  speaker: string | null,
  source: 'user' | 'assistant',
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (source === 'assistant' && !isFactBearingAssistantTurn(trimmed)) return;
  turns.push({ speaker, text: trimmed, source });
}

/** Split a user turn into individual sentences. */
function splitSentences(text: string): string[] {
  const protectedText = protectAbbreviations(text);
  return protectedText
    .split(/(?<=[.!?])\s+|(?<=\n)/)
    .map(restoreAbbreviations)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

/** Check if a sentence contains a fact statement worth extracting. */
function isFactStatement(sentence: string): boolean {
  return FIRST_PERSON_PATTERNS.some((p) => p.test(sentence))
    || looksLikeImplicitFirstPersonEvent(sentence)
    || looksLikeStandaloneFact(sentence)
    || looksLikeThirdPersonDeclarative(sentence);
}

/** Classify the fact type based on content patterns. */
function classifyType(sentence: string): ExtractedFact['type'] {
  for (const { pattern, type } of TYPE_PATTERNS) {
    if (pattern.test(sentence)) return type;
  }
  return 'knowledge';
}

/** Assign importance (0-1) based on specificity signals. */
function estimateImportance(sentence: string): number {
  let score = 0.5;
  if (/\b(?:always|never|every|must|critical|important|key)\b/i.test(sentence)) score += 0.2;
  if (/\b(?:my name|I am|I work|my role|my team|my company)\b/i.test(sentence)) score += 0.15;
  if (/\d/.test(sentence)) score += 0.1; // contains numbers (dates, versions, etc.)
  if (sentence.length > 100) score += 0.05; // longer = more specific
  return Math.min(1, score);
}

/** Extract entities from text using pattern matching and capitalization. */
function extractEntities(sentence: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // Pattern-based entity extraction (tools, orgs)
  for (const { pattern, type } of ENTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sentence)) !== null) {
      const name = match[0];
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        entities.push({ name, type });
      }
    }
  }

  // Capitalized proper nouns (likely person/place names)
  // Skip sentence starts and common words
  const SKIP_WORDS = new Set(['I', 'The', 'A', 'An', 'My', 'We', 'Our', 'It', 'This', 'That', 'But', 'And', 'Or', 'So', 'If', 'When', 'What', 'How', 'Why', 'Where', 'Yes', 'No', 'Also', 'Just', 'Really', 'Actually', 'Currently', 'Recently', 'Usually', 'Sometimes', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
  const words = sentence.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^a-zA-Z]/g, '');
    if (word.length > 1 && /^[A-Z]/.test(word) && !SKIP_WORDS.has(word) && !seen.has(word.toLowerCase())) {
      seen.add(word.toLowerCase());
      entities.push({ name: word, type: 'concept' });
    }
  }

  return entities;
}

function protectAbbreviations(text: string): string {
  return text
    .replace(/\bDr\./g, 'Dr<prd>')
    .replace(/\bMr\./g, 'Mr<prd>')
    .replace(/\bMrs\./g, 'Mrs<prd>')
    .replace(/\bMs\./g, 'Ms<prd>')
    .replace(/\bProf\./g, 'Prof<prd>');
}

function restoreAbbreviations(text: string): string {
  return text.replace(/<prd>/g, '.');
}

function looksLikeStandaloneFact(sentence: string): boolean {
  if (sentence.endsWith('?')) return false;
  if (sentence.length < 16) return false;
  return hasStandaloneEntity(sentence)
    || /\b\d{4}\b/.test(sentence)
    || QUOTED_TEXT_PATTERN.test(sentence)
    || LITERAL_DETAIL_PATTERN.test(sentence)
    || EVENT_DETAIL_PATTERN.test(sentence);
}

/**
 * Detect third-person declarative statements that carry factual content.
 * Catches patterns like "Maria Chen is the engineering lead",
 * "The daily standup is at 9:30 AM", "Sprint velocity averaged 34 points",
 * "Our deployment strategy prioritizes zero-downtime releases".
 *
 * Guards: requires at least one specificity signal (proper noun subject,
 * determiner-led subject + verb, numeric data, or time expression) to
 * avoid extracting generic statements.
 */
function looksLikeThirdPersonDeclarative(sentence: string): boolean {
  if (sentence.endsWith('?')) return false;
  if (sentence.length < 20) return false;

  const DECLARATIVE_VERBS = /(?:is|was|are|were|has|had|leads?|manages?|runs?|works?|heads?|handles?|provides?|requires?|follows?|supports?|enables?|triggers?|processes?|happens?|occurs?|communicates?|serves?|guarantees?|prioritizes?|includes?|needs?|ships?|deploys?|reviews?|schedules?|averages?|takes?|starts?|meets?|begins?|ends?|costs?|uses?|optimizes?|streamlines?)\b/;
  const PROPER_NOUN_EXCLUDE = '(?!(?:It|That|Something|Everything|Everyone|Nothing|Anything|Anyone|Okay|Sure|Well|So|Maybe|Perhaps|Probably|Obviously|Clearly|Basically|Actually|Apparently|Honestly|Definitely|Certainly)\\b)';
  const hasProperNounSubject = new RegExp('^' + PROPER_NOUN_EXCLUDE + '[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*\\s+' + DECLARATIVE_VERBS.source).test(sentence);
  const hasDeterminerSubject = new RegExp('^(?:The|A|An|Our|This|Each|Every|All)\\s+\\w+(?:\\s+\\w+)?\\s+' + DECLARATIVE_VERBS.source).test(sentence);
  const hasAcronymSubject = new RegExp('^[A-Z]{2,}(?:[/ ][A-Z]{2,})*\\s+(?:\\w+\\s+)?' + DECLARATIVE_VERBS.source).test(sentence);
  const hasCompoundNounSubject = new RegExp('^[A-Z][a-z]+\\s+[a-z]+(?:\\s+[a-z]+)?\\s+' + DECLARATIVE_VERBS.source).test(sentence);
  const hasNumericData = /\b\d+(?:\.\d+)?\s*(?:story points?|points?|percent|%|minutes?|hours?|days?|weeks?|months?|sprints?|users?|requests?|items?|members?|milliseconds?|seconds?|ms|MB|GB|TB|million|billion|k)\b/i.test(sentence);
  const hasTimeExpression = /\b\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?\b/.test(sentence);
  const hasPassiveDeclarative = /^(?:The|A|An|Our|This|Each|Every|All)\s+\w+(?:\s+\w+)?\s+(?:is|are|was|were)\s+\w+ed\b/.test(sentence);

  return hasProperNounSubject || hasDeterminerSubject || hasAcronymSubject
    || hasCompoundNounSubject || hasNumericData || hasTimeExpression || hasPassiveDeclarative;
}

function parseSessionDate(text: string): string | null {
  const match = text.match(SESSION_DATE_PATTERN);
  if (!match) return null;
  const year = match[1];
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthName = MONTH_NAMES[month - 1];
  return monthName ? `${monthName} ${day} ${year}` : null;
}

function parseSessionDateValue(text: string): Date | null {
  const match = text.match(SESSION_DATE_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  return new Date(Date.UTC(year, monthIndex, day, 0, 0, 0, 0));
}

function shouldExtractWholeTurn(turn: string, sentences: string[]): boolean {
  if (sentences.length < 2) return false;
  if (turn.length > 280) return false;
  return sentences.some((sentence) => isFactStatement(sentence));
}

/**
 * Strip speaker labels and filler words from a candidate fact sentence.
 * Uses a stricter pattern than SPEAKER_PREFIX_PATTERN to avoid stripping
 * text before numeric colons (e.g., "at 9:30 AM" must not be truncated).
 */
function normalizeCandidateText(text: string): string {
  return text
    .replace(/^[A-Z][A-Za-z' -]{1,40}(?<!\d):\s+/, '')
    .replace(/^(?:Oh,\s*btw,?|btw,?|well,|so,|yeah,|hah,|haha,)\s*/i, '')
    .trim();
}

function anchorFact(sentence: string, sessionDate: string | null, sessionDateValue: Date | null): string {
  const normalizedInput = normalizeCandidateText(sentence);
  const rewritten = resolveLeadEntityReference(rewriteLeadPronoun(normalizedInput));
  const normalized = sessionDateValue
    ? annotateRelativeTemporalText(rewritten, sessionDateValue)
    : rewritten;
  if (!sessionDate || /\bAs of\b/i.test(normalized) || EXPLICIT_ABSOLUTE_DATE_PATTERN.test(rewritten)) {
    return normalized;
  }
  return `As of ${sessionDate}, ${formatAnchoredBody(normalized)}`;
}

/**
 * Anchor an assistant-sourced fact with the session date.
 * Unlike user facts, assistant sentences do not get first-person rewriting —
 * they are stored closer to their original form with a date prefix.
 * Preserves leading capitalization for proper nouns (e.g., "Miss Bee").
 */
function anchorAssistantFact(sentence: string, sessionDate: string | null): string {
  const trimmed = sentence.trim();
  if (!sessionDate || /\bAs of\b/i.test(trimmed) || EXPLICIT_ABSOLUTE_DATE_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const startsWithProperNoun = /^[A-Z][a-z]/.test(trimmed) && !/^(?:The|A|An|This|That|It|Here|There)\b/.test(trimmed);
  const body = startsWithProperNoun ? trimmed : lowercaseLead(trimmed);
  return `As of ${sessionDate}, ${body}`;
}

function rewriteLeadPronoun(sentence: string): string {
  const cleaned = sentence.trim();
  return cleaned
    .replace(/^I['’]d\b/i, 'user would')
    .replace(/^I['’]ll\b/i, 'user will')
    .replace(/^I['']ve\b/i, 'user has')
    .replace(/^I['']m\b/i, 'user is')
    .replace(/^I\b/i, 'user')
    .replace(/^My\b/i, "user's");
}

function lowercaseLead(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function formatAnchoredBody(text: string): string {
  return /^user\b/i.test(text) ? lowercaseLead(text) : text;
}

function resolveLeadEntityReference(text: string): string {
  const originalMatch = text.match(/^([A-Z][A-Za-z0-9.+ -]{1,60})\.\s+I['']ve been using it\b/i);
  if (originalMatch) {
    const entity = originalMatch[1].trim();
    return text.replace(
      /^([A-Z][A-Za-z0-9.+ -]{1,60})\.\s+I['']ve been using it\b/i,
      `user has been using ${entity}`,
    );
  }

  const rewrittenMatch = text.match(/^([A-Z][A-Za-z0-9.+ -]{1,60})\.\s+(user(?:\s+has\s+been)?\s+(?:using|preferring|liking))\s+it\b/i);
  if (!rewrittenMatch) return text;
  const entity = rewrittenMatch[1].trim();
  const predicate = rewrittenMatch[2];
  return `${predicate} ${entity}${text.slice(rewrittenMatch[0].length)}`;
}

function looksLikeImplicitFirstPersonEvent(sentence: string): boolean {
  const normalized = normalizeCandidateText(sentence);
  if (!IMPLICIT_FIRST_PERSON_EVENT_PATTERN.test(normalized)) {
    return false;
  }
  return containsHighSignalEventDetail(normalized) || QUOTED_TEXT_PATTERN.test(normalized);
}

function containsHighSignalEventDetail(text: string): boolean {
  return EVENT_DETAIL_PATTERN.test(text)
    || LITERAL_DETAIL_PATTERN.test(text)
    || /\b(?:today|tomorrow|yesterday|last\s+\w+)\b/i.test(text);
}

/** Generate a concise headline from a fact sentence. */
function generateHeadline(sentence: string): string {
  const words = sentence.split(/\s+/).slice(0, 8);
  return words.join(' ') + (words.length < sentence.split(/\s+/).length ? '...' : '');
}

/** Extract keywords (significant words) from sentence. */
function extractKeywords(sentence: string): string[] {
  const STOP_WORDS = new Set(['i', 'me', 'my', 'we', 'our', 'the', 'a', 'an', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'that', 'this', 'it', 'not', 'but', 'and', 'or', 'so', 'if', 'than', 'too', 'very', 'just', 'also', 'really', 'actually', 'currently', 'been', 'being']);
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 10);
}

/**
 * Quick fact extraction — rule-based, no LLM calls.
 * Returns ExtractedFact[] compatible with the full extraction pipeline.
 * Processes both user turns (first-person fact detection) and fact-bearing
 * assistant turns (specific content detection).
 */
export function quickExtractFacts(conversationText: string): ExtractedFact[] {
  const turns = extractFactBearingTurns(conversationText);
  const sessionDate = parseSessionDate(conversationText);
  const sessionDateValue = parseSessionDateValue(conversationText);
  const facts: ExtractedFact[] = [];
  const seenFacts = new Set<string>();

  for (const turn of turns) {
    extractFactsFromTurn(turn, conversationText, sessionDate, sessionDateValue, seenFacts, facts);
  }

  return enrichExtractedFacts(facts);
}

/** Extract facts from a single turn's sentences and add to the accumulator. */
function extractFactsFromTurn(
  turn: { text: string; source: string; speaker: string | null },
  contextText: string,
  sessionDate: string | null,
  sessionDateValue: Date | null,
  seenFacts: Set<string>,
  facts: ExtractedFact[],
): void {
  const sentences = splitSentences(turn.text);
  const isAssistant = turn.source === 'assistant';
  const candidates = shouldExtractWholeTurn(turn.text, sentences)
    ? [...sentences, turn.text]
    : sentences;

  for (const sentence of candidates) {
    const fact = processSentence(sentence, isAssistant, turn.speaker, sessionDate, sessionDateValue, seenFacts);
    if (fact) facts.push(resolveContextualObjectReference(fact, contextText));
  }
}

/** Process a single sentence into an ExtractedFact or null if filtered/duplicate. */
function processSentence(
  sentence: string,
  isAssistant: boolean,
  speaker: string | null,
  sessionDate: string | null,
  sessionDateValue: Date | null,
  seenFacts: Set<string>,
): ExtractedFact | null {
  const speakerAwareSentence = isAssistant ? sentence : applySpeakerSubject(sentence, speaker);
  const passesFilter = isAssistant
    ? isAssistantFactStatement(sentence)
    : (isFactStatement(sentence) || isFactStatement(speakerAwareSentence));
  if (!passesFilter) return null;

  const factText = isAssistant
    ? anchorAssistantFact(sentence, sessionDate)
    : anchorFact(speakerAwareSentence, sessionDate, sessionDateValue);
  const normalized = factText.toLowerCase().replace(/\s+/g, ' ').trim();
  if (seenFacts.has(normalized)) return null;
  seenFacts.add(normalized);

  return {
    fact: factText,
    headline: generateHeadline(factText),
    importance: isAssistant ? estimateImportance(factText) * 0.9 : estimateImportance(factText),
    type: classifyType(factText),
    keywords: extractKeywords(factText),
    entities: extractEntities(factText),
    relations: [],
  };
}

function applySpeakerSubject(sentence: string, speaker: string | null): string {
  if (!speaker) {
    return sentence;
  }
  const impliedSpeaker = sentence.replace(
    /^(?:Appreciate[^,]{0,80},\s+but\s+)?had\b/i,
    `${speaker} had`,
  );
  return impliedSpeaker
    .replace(/\bI['’]d\b/g, `${speaker} would`)
    .replace(/\bI['’]ll\b/g, `${speaker} will`)
    .replace(/\bI['’]ve\b/g, `${speaker} has`)
    .replace(/\bI['’]m\b/g, `${speaker} is`)
    .replace(/\bI\b/g, speaker)
    .replace(/\bmy\b/gi, `${speaker}'s`);
}

function resolveContextualObjectReference(fact: ExtractedFact, turnText: string): ExtractedFact {
  if (!/\bhad them for\b/i.test(fact.fact)) {
    return fact;
  }
  const object = findContextualObject(turnText);
  if (!object) {
    return fact;
  }
  return {
    ...fact,
    fact: fact.fact.replace(/\bhad them for\b/i, `had the ${object} for`),
  };
}

function findContextualObject(text: string): string | null {
  const match = text.match(/\b(turtles|snakes|dogs|cats|pets)\b/i);
  return match ? match[1].toLowerCase() : null;
}
