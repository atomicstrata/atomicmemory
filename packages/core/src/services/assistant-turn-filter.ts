/**
 * Fact-bearing assistant turn detection for quick-extraction.
 *
 * Filters assistant conversation turns to identify those that carry
 * extractable factual content (named entities, specific details, data)
 * while rejecting generic chatter (acknowledgments, meta-commentary).
 *
 * Used by quick-extraction.ts to process assistant turns alongside
 * user turns without flooding memory with low-value content.
 */

/** Minimum length for an assistant turn to be considered fact-bearing. */
const MIN_ASSISTANT_TURN_LENGTH = 60;

/** Generic assistant openings that signal non-factual chatter. */
const ASSISTANT_CHATTER_PATTERNS = [
  /^(?:sure|got it|no problem|of course|certainly|absolutely|great|okay|ok)[!,.\s]/i,
  /^(?:i can help|i'd be happy|let me|here (?:are|is) (?:a|some|the) (?:general|brief))/i,
  /^as an ai\b/i,
  /^i don't have personal/i,
  /^(?:enjoy|have a great|good luck|feel free)/i,
  /^(?:you're welcome|glad i could help|happy to help)/i,
];

import type { ExtractedEntity } from './extraction.js';
import {
  ENTITY_PATTERNS,
  QUOTED_TEXT_PATTERN,
  LITERAL_DETAIL_PATTERN,
  EVENT_DETAIL_PATTERN,
  hasStandaloneEntity,
} from './content-detection.js';

/** Detect specific content: entities, numbers, proper nouns, structured data. */
function hasSpecificContent(text: string): boolean {
  if (hasStandaloneEntity(text)) return true;
  if (/\b\d{1,2}(?:\s*(?:am|pm|:)\s*\d{0,2})\b/i.test(text)) return true;
  if (QUOTED_TEXT_PATTERN.test(text)) return true;
  if (LITERAL_DETAIL_PATTERN.test(text)) return true;
  if (EVENT_DETAIL_PATTERN.test(text)) return true;
  if (/\b\d{4}\b/.test(text)) return true;
  if (/\|.*\|/.test(text)) return true;
  // Proper noun sequences (e.g., "Miss Bee Providore", "Tangkuban Perahu")
  if (/[A-Z][a-z]+\s+[A-Z][a-z]/.test(text)) return true;
  return false;
}

/**
 * Check if an assistant turn is likely to contain extractable facts.
 * Filters out short acknowledgments and generic meta-commentary.
 */
export function isFactBearingAssistantTurn(text: string): boolean {
  if (text.length < MIN_ASSISTANT_TURN_LENGTH) return false;
  const firstLine = text.split('\n')[0];
  if (ASSISTANT_CHATTER_PATTERNS.some((pattern) => pattern.test(firstLine))) {
    return hasSpecificContent(text);
  }
  return true;
}

/**
 * Check if an assistant sentence contains specific factual content worth
 * extracting: named entities, numbers/dates, proper nouns, or list items.
 */
export function isAssistantFactStatement(sentence: string): boolean {
  if (sentence.endsWith('?')) return false;
  if (sentence.length < 20) return false;
  if (ASSISTANT_CHATTER_PATTERNS.some((pattern) => pattern.test(sentence))) return false;
  return hasSpecificContent(sentence);
}
