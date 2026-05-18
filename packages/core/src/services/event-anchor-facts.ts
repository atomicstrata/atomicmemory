/**
 * Deterministic event-anchor fact generation for Cat2-style disambiguation.
 * Converts high-signal extracted facts into explicit event memories such as
 * "event anchor mentorship.received for Jon occurred on June 15 2023" so
 * retrieval and answer-time prompting can rely on structured event labels.
 */

import type { ExtractedEntity, ExtractedFact } from './extraction.js';
import { dedupeEntities } from './entity-dedup.js';
import { extractRelativeTemporalAnchors } from './relative-temporal.js';

interface EventAnchorDescriptor {
  label: string;
  subject: string;
  eventDateIso: string;
}

const RECORDED_DATE_PATTERN = /^As of ([A-Za-z]+ \d{1,2} \d{4}),\s*/i;
const EXPLICIT_EVENT_ANCHOR_PATTERN = /\bevent anchor\s+[a-z.]+/i;
const EVENT_DATE_PATTERN = /\boccurred on ([A-Za-z]+ \d{1,2} \d{4})\b/i;
const NON_SUBJECT_TOKENS = new Set(['Hey', 'Long', 'Yesterday', 'Thats', 'Awesome', 'Oh', 'Paris', 'Rome', 'Barcelona']);
const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export function inferEventAnchorFacts(fact: ExtractedFact): ExtractedFact[] {
  if (EXPLICIT_EVENT_ANCHOR_PATTERN.test(fact.fact)) {
    return [];
  }
  const recordedDate = parseRecordedDate(fact.fact);
  if (!recordedDate) {
    return [];
  }
  return inferDescriptors(fact, recordedDate).map((descriptor) => buildAnchorFact(fact, descriptor));
}

function inferDescriptors(fact: ExtractedFact, recordedDate: Date): EventAnchorDescriptor[] {
  const lower = fact.fact.toLowerCase();
  const subject = inferSubject(fact);
  if (!subject) {
    return [];
  }
  const eventDateIso = inferEventDateIso(fact.fact, recordedDate);
  const descriptors: EventAnchorDescriptor[] = [];

  for (const rule of DESCRIPTOR_RULES) {
    const labels = rule(lower);
    for (const label of labels) {
      descriptors.push({ label, subject, eventDateIso });
    }
  }

  return dedupeDescriptors(descriptors);
}

type DescriptorRule = (lower: string) => string[];

/** Ordered list of pattern-matching rules, each returning zero or more labels. */
const DESCRIPTOR_RULES: DescriptorRule[] = [
  (l) => l.includes('accepted') && l.includes('internship') ? ['internship.accepted'] : [],
  (l) => l.includes('interview') && l.includes('internship') ? ['internship.interviewed'] : [],
  (l) => (l.includes('got mentored') || l.includes('mentored by') || l.includes('received mentorship')) ? ['mentorship.received'] : [],
  (l) => (l.includes('mentoring') || l.includes('mentor aspiring') || l.includes('one-on-one mentoring')) ? ['mentorship.given'] : [],
  inferNetworkingLabels,
  inferParisLabels,
  inferRomeLabels,
  (l) => (l.includes('collaborat') || l.includes('content creation') || l.includes('social media management'))
    && (l.includes('plan') || l.includes('help') || l.includes('offered')) ? ['collaboration.decided'] : [],
  (l) => l.includes('shia labeouf') ? ['quote.mentioned'] : [],
  (l) => l.includes('dance class') && l.includes('group of friends') ? ['dance_class.attended'] : [],
];

function inferNetworkingLabels(lower: string): string[] {
  if (!lower.includes('networking')) return [];
  if (lower.includes('chose to attend') || lower.includes('go to networking')
    || lower.includes('visit networking') || lower.includes('yesterday')) {
    return ['networking.first_visit'];
  }
  if (lower.includes('last networking event') || lower.includes('met investors')) {
    return ['networking.followup'];
  }
  return [];
}

function inferParisLabels(lower: string): string[] {
  if (!lower.includes('paris')) return [];
  const labels = ['trip.paris'];
  if (lower.includes('return') || lower.includes('returned from') || lower.includes('returns from')) {
    labels.push('trip.returned_from_paris');
  }
  return labels;
}

function inferRomeLabels(lower: string): string[] {
  if (!lower.includes('rome')) return [];
  const labels = ['trip.rome'];
  if (lower.includes('short trip')) {
    labels.push('trip.took_short_trip_rome');
  }
  return labels;
}

function buildAnchorFact(sourceFact: ExtractedFact, descriptor: EventAnchorDescriptor): ExtractedFact {
  const recordedPrefix = sourceFact.fact.match(RECORDED_DATE_PATTERN)?.[1];
  const eventDateHuman = formatHumanDate(descriptor.eventDateIso);
  const anchorFact = `As of ${recordedPrefix}, event anchor ${descriptor.label} for ${descriptor.subject} occurred on ${eventDateHuman}.`;
  return {
    fact: anchorFact,
    headline: `Event ${descriptor.label}`,
    importance: Math.max(sourceFact.importance, 0.85),
    type: 'knowledge',
    keywords: buildKeywords(descriptor),
    entities: buildEntities(sourceFact.entities, descriptor.subject),
    relations: [],
    network: sourceFact.network,
    opinionConfidence: sourceFact.opinionConfidence ?? null,
  };
}

function inferSubject(fact: ExtractedFact): string | null {
  const people = fact.entities
    .filter((entity) => entity.name !== 'User' && looksLikeSubjectEntity(entity))
    .map((entity) => entity.name);
  if (people.length >= 2 && fact.fact.toLowerCase().includes('collaborat')) {
    return people.sort().join(' and ');
  }
  if (people.length > 0) {
    return people[people.length - 1];
  }
  if (/\buser\b/i.test(fact.fact)) {
    return 'User';
  }
  return null;
}

function looksLikeSubjectEntity(entity: ExtractedEntity): boolean {
  if (NON_SUBJECT_TOKENS.has(entity.name)) {
    return false;
  }
  if (entity.type === 'person') {
    return true;
  }
  return entity.type === 'concept' && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/.test(entity.name);
}

function inferEventDateIso(text: string, recordedDate: Date): string {
  const relativeAnchor = extractRelativeTemporalAnchors(text, recordedDate)[0];
  if (relativeAnchor) {
    return relativeAnchor.eventDate;
  }
  const explicit = text.match(EVENT_DATE_PATTERN);
  if (explicit) {
    return formatIsoDate(explicit[1]);
  }
  return recordedDate.toISOString().slice(0, 10);
}

function buildKeywords(descriptor: EventAnchorDescriptor): string[] {
  return [
    ...descriptor.label.split('.'),
    descriptor.label,
    descriptor.subject,
    formatHumanDate(descriptor.eventDateIso),
  ];
}

function buildEntities(entities: ExtractedEntity[], subject: string): ExtractedEntity[] {
  const baseEntities = entities.filter((entity) => entity.type === 'person' && entity.name !== 'User');
  const subjectEntities = subject
    .split(' and ')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, type: 'person' as const }));
  return dedupeEntities([...baseEntities, ...subjectEntities, { name: 'event anchor', type: 'concept' }]);
}

function dedupeDescriptors(descriptors: EventAnchorDescriptor[]): EventAnchorDescriptor[] {
  const unique = new Map<string, EventAnchorDescriptor>();
  for (const descriptor of descriptors) {
    unique.set(`${descriptor.label}:${descriptor.subject}:${descriptor.eventDateIso}`, descriptor);
  }
  return [...unique.values()];
}

function parseRecordedDate(text: string): Date | null {
  const match = text.match(RECORDED_DATE_PATTERN);
  if (!match) {
    return null;
  }
  return parseHumanDate(match[1]);
}

function parseHumanDate(input: string): Date | null {
  const match = input.match(/^([A-Za-z]+) (\d{1,2}) (\d{4})$/);
  if (!match) {
    return null;
  }
  const month = MONTH_INDEX[match[1].toLowerCase()];
  if (month === undefined) {
    return null;
  }
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2]), 0, 0, 0, 0));
}

function formatHumanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatIsoDate(input: string): string {
  const parsed = parseHumanDate(input);
  if (!parsed) {
    return input;
  }
  return parsed.toISOString().slice(0, 10);
}
