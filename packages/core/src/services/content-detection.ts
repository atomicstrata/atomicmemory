/**
 * Shared content-detection patterns and helpers.
 *
 * Used by both assistant-turn-filter.ts and quick-extraction.ts to identify
 * entity mentions, quoted text, literal details, and event details in text.
 * Extracted to eliminate duplication between those two modules.
 */

import type { ExtractedEntity } from './extraction.js';

/** Regex patterns for known entity types (tools, orgs, conferences, people, projects). */
export const ENTITY_PATTERNS: Array<{ pattern: RegExp; type: ExtractedEntity['type'] }> = [
  { pattern: /\b(?:Tailwind CSS|Plaid|tRPC|TanStack Virtual|React Query|Supabase|Vite|React|Vue|Angular|Svelte|Next\.js|Nuxt|Express|FastAPI|Django|Flask|Rails|Spring|Kubernetes|Docker|AWS|GCP|Azure|Vercel|Netlify|GitHub|GitLab|Jira|Linear|Slack|Notion|Figma|PostgreSQL|MongoDB|Redis|Elasticsearch|TypeScript|Python|Rust|Go|Java|Swift|Kotlin|GRE)\b/g, type: 'tool' },
  { pattern: /\b(?:Microsoft Research|MSR|Google DeepMind|Meta FAIR|Stanford|MIT|CMU|UC Berkeley|Google|Apple|Microsoft|Amazon|Meta|Netflix|Stripe|Shopify|Twilio|Datadog|Snowflake|Databricks|OpenAI|Anthropic)\b/g, type: 'organization' },
  { pattern: /\b(?:EMNLP|ACL|NeurIPS|ICML)\s+\d{4}\b/g, type: 'concept' },
  { pattern: /\bDr\.?\s+[A-Z][a-z]+\b/g, type: 'person' },
  { pattern: /\b(?:finance tracker|dotctl)\b/gi, type: 'project' },
];

export const QUOTED_TEXT_PATTERN = /["""][^"""]{2,}["""]/;

export const LITERAL_DETAIL_PATTERN =
  /\b(?:necklace|book|books|song|songs|music|musicians|fan|painting|paintings|photo|poster|posters|library|store|decor|furniture|flooring|pet|pets|cat|cats|dog|dogs|guinea pig|turtle|turtles|snake|snakes|workshop|poetry reading|sign|slipper|bowl)\b/i;

export const EVENT_DETAIL_PATTERN =
  /\b(?:accepted|interview|internship|mentor(?:ed|ing)?|network(?:ing)?|social media|competition|investor(?:s)?|fashion editors|analytics tools|video presentation|website|collaborat(?:e|ion)|dance class|Shia Labeouf|trip|travel(?:ed|ling)?|retreat|phuket|doctor|doc|check-up|appointment|blog|car mods?|restor(?:e|ed|ing|ation)|paris|rome)\b/i;

/** Check whether text contains any known entity pattern. */
export function hasStandaloneEntity(sentence: string): boolean {
  return ENTITY_PATTERNS.some(({ pattern }) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    return regex.test(sentence);
  });
}
