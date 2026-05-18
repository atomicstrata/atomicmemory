/**
 * Trust scoring for memories at write time.
 *
 * Computes a trust score (0.0–1.0) based on source domain reputation,
 * content characteristics, and injection pattern detection. The score
 * is stored alongside each memory and used at retrieval time to filter
 * or down-rank low-trust content.
 *
 * Phase 3 security baseline — threat-model.md P0 item.
 * Based on A-MemGuard (simplified) and reference-implementations.md §8.
 */

import { sanitize, type SanitizationResult } from './input-sanitizer.js';

/** Trust score with breakdown of contributing signals. */
export interface TrustScore {
  score: number;
  domainTrust: number;
  contentPenalty: number;
  injectionPenalty: number;
  sanitization: SanitizationResult;
}

/**
 * Known trusted domains where content is likely user-authored and legitimate.
 * Memories from trusted domains start at 1.0; unknown domains start at 0.8.
 */
const TRUSTED_DOMAINS = new Set([
  'claude.ai',
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'github.com',
  'stackoverflow.com',
  'docs.google.com',
  'notion.so',
]);

const UNKNOWN_DOMAIN_PENALTY = 0.2;
const INJECTION_PENALTY_PER_MATCH = 0.3;
const CONTENT_WARN_PENALTY = 0.1;
const MAX_INJECTION_PENALTY = 0.9;

/**
 * Compute a trust score for a memory based on its content and source.
 *
 * Score starts at 1.0 and is reduced by:
 * - Unknown source domain: -0.2
 * - Each injection pattern match: -0.3 (capped at -0.9)
 * - Content anomalies (length, unicode, repetition): -0.1 each
 *
 * Final score is clamped to [0.0, 1.0].
 */
export function computeTrustScore(content: string, sourceSite: string): TrustScore {
  const sanitization = sanitize(content);

  const domainTrust = isDomainTrusted(sourceSite) ? 0 : UNKNOWN_DOMAIN_PENALTY;

  const injectionCount = sanitization.findings.filter((f) => f.rule.startsWith('injection:')).length;
  const injectionPenalty = Math.min(injectionCount * INJECTION_PENALTY_PER_MATCH, MAX_INJECTION_PENALTY);

  const warnCount = sanitization.findings.filter((f) => f.severity === 'warn').length;
  const contentPenalty = warnCount * CONTENT_WARN_PENALTY;

  const score = Math.max(0, Math.min(1, 1.0 - domainTrust - injectionPenalty - contentPenalty));

  return {
    score,
    domainTrust: 1.0 - domainTrust,
    contentPenalty,
    injectionPenalty,
    sanitization,
  };
}

/** Check if a domain is in the trusted set. */
export function isDomainTrusted(sourceSite: string): boolean {
  const normalized = normalizeSourceSite(sourceSite);
  if (!normalized) return false;
  return Array.from(TRUSTED_DOMAINS).some(
    (trustedDomain) => normalized === trustedDomain || normalized.endsWith(`.${trustedDomain}`),
  );
}

/**
 * Determine if a memory should be stored based on its trust score.
 * Returns true if the score meets the minimum threshold.
 */
export function meetsMinimumTrust(trustScore: TrustScore, threshold: number): boolean {
  return trustScore.score >= threshold;
}

/**
 * Apply a trust-based penalty to a retrieval score.
 * Low-trust memories are down-ranked proportionally.
 */
export function applyTrustPenalty(retrievalScore: number, trustScore: number): number {
  return retrievalScore * trustScore;
}

function normalizeSourceSite(sourceSite: string): string {
  const trimmed = sourceSite.trim().toLowerCase().replace(/\.+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return trimmed;
  }
}
