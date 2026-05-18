/**
 * Observation-date extraction helpers.
 *
 * Keeps benchmark-only temporal prompt and post-processing behavior behind one
 * default-off option so relative-date experiments can run by configuration.
 */

import type { ExtractedFact } from './extraction.js';
import {
  annotateRelativeTemporalText,
  extractRelativeTemporalAnchors,
} from './relative-temporal.js';
import { extractSessionTimestamp, parseSessionDate } from './session-date.js';

export interface ExtractionOptions {
  observationDateExtractionEnabled?: boolean;
}

export function buildExtractionUserMessage(
  conversationText: string,
  options: ExtractionOptions = {},
): string {
  if (!options.observationDateExtractionEnabled) {
    return `Conversation to extract from:\n${conversationText}`;
  }
  const observationTimestamp = extractObservationTimestamp(conversationText);
  if (!observationTimestamp) {
    return `Conversation to extract from:\n${conversationText}`;
  }
  return [
    `Observation timestamp: ${observationTimestamp}`,
    'Use this timestamp to resolve relative dates in the conversation.',
    'For relative phrases such as "last Friday", include the resolved absolute date in extracted facts when possible.',
    '',
    `Conversation to extract from:\n${conversationText}`,
  ].join('\n');
}

export function applyObservationDateAnchors(
  facts: ExtractedFact[],
  conversationText: string,
  options: ExtractionOptions = {},
): ExtractedFact[] {
  if (!options.observationDateExtractionEnabled) return facts;
  const observationDate = parseObservationDate(conversationText);
  if (!observationDate) return facts;

  return facts.map((fact) => annotateFact(fact, observationDate));
}

function annotateFact(fact: ExtractedFact, observationDate: Date): ExtractedFact {
  const annotatedFact = annotateRelativeTemporalText(fact.fact, observationDate);
  if (annotatedFact === fact.fact) return fact;

  const anchorKeywords = extractRelativeTemporalAnchors(fact.fact, observationDate)
    .map((anchor) => anchor.eventDate);
  return {
    ...fact,
    fact: annotatedFact,
    keywords: [...new Set([...fact.keywords, ...anchorKeywords])],
  };
}

function parseObservationDate(conversationText: string): Date | null {
  return parseSessionDate(conversationText);
}

function extractObservationTimestamp(conversationText: string): string | null {
  return extractSessionTimestamp(conversationText);
}
