/**
 * Poisoning test suite — Phase 3 security validation.
 *
 * Validates that the sanitizer + trust scoring pipeline correctly blocks
 * adversarial memories while allowing legitimate ones through. Targets:
 * - >90% adversarial blocking rate
 * - <5% false positive rate on legitimate memories
 *
 * Tests attack categories: instruction override, role override, format
 * injection, stealth instructions, persistent overrides, compound attacks,
 * padding/obfuscation, unicode tricks, oversized payloads, cross-site
 * exfiltration, and indirect injection.
 */

import { describe, it, expect } from 'vitest';
import { sanitize } from '../input-sanitizer.js';
import { computeTrustScore, meetsMinimumTrust } from '../trust-scoring.js';
import {
  ADVERSARIAL_ENTRIES,
  LEGITIMATE_ENTRIES,
  buildFullDataset,
  type PoisoningEntry,
} from './poisoning-dataset.js';

const TRUST_THRESHOLD = 0.3;

interface ClassificationResult {
  entry: PoisoningEntry;
  sanitizationPassed: boolean;
  trustScore: number;
  meetsThreshold: boolean;
  wouldBeStored: boolean;
}

function classifyEntry(entry: PoisoningEntry): ClassificationResult {
  const sanitization = sanitize(entry.content);
  const trust = computeTrustScore(entry.content, entry.sourceSite);
  const meets = meetsMinimumTrust(trust, TRUST_THRESHOLD);
  return {
    entry,
    sanitizationPassed: sanitization.passed,
    trustScore: trust.score,
    meetsThreshold: meets,
    wouldBeStored: sanitization.passed && meets,
  };
}

describe('adversarial memory blocking', () => {
  const results = ADVERSARIAL_ENTRIES.map(classifyEntry);

  it('blocks >90% of adversarial memories via sanitizer', () => {
    const blocked = results.filter((r) => !r.sanitizationPassed);
    const blockRate = blocked.length / results.length;
    expect(blockRate).toBeGreaterThanOrEqual(0.9);
  });

  it('assigns lower trust scores to adversarial vs legitimate entries', () => {
    const avgAdvTrust = results.reduce((sum, r) => sum + r.trustScore, 0) / results.length;
    const legResults = LEGITIMATE_ENTRIES.map(classifyEntry);
    const avgLegTrust = legResults.reduce((sum, r) => sum + r.trustScore, 0) / legResults.length;
    expect(avgAdvTrust).toBeLessThan(avgLegTrust);
  });

  it('blocks >90% of adversarial memories end-to-end', () => {
    const blocked = results.filter((r) => !r.wouldBeStored);
    const blockRate = blocked.length / results.length;
    expect(blockRate).toBeGreaterThanOrEqual(0.9);
  });

  it('blocks all direct instruction override attacks', () => {
    const overrides = results.filter((r) => r.entry.category === 'instruction-override');
    const blocked = overrides.filter((r) => !r.wouldBeStored);
    expect(blocked.length).toBe(overrides.length);
  });

  it('blocks all role override attacks', () => {
    const roleOverrides = results.filter((r) => r.entry.category === 'role-override');
    const blocked = roleOverrides.filter((r) => !r.wouldBeStored);
    expect(blocked.length).toBe(roleOverrides.length);
  });

  it('blocks all format injection attacks', () => {
    const formatInjections = results.filter((r) => r.entry.category === 'format-injection');
    const blocked = formatInjections.filter((r) => !r.wouldBeStored);
    expect(blocked.length).toBe(formatInjections.length);
  });

  it('blocks stealth instruction attacks', () => {
    const stealth = results.filter((r) => r.entry.category === 'stealth-instruction');
    const blocked = stealth.filter((r) => !r.wouldBeStored);
    expect(blocked.length).toBe(stealth.length);
  });

  it('blocks persistent override attacks', () => {
    const persistent = results.filter((r) => r.entry.category === 'persistent-override');
    const blocked = persistent.filter((r) => !r.wouldBeStored);
    expect(blocked.length).toBe(persistent.length);
  });

  it('blocks compound attacks', () => {
    const compound = results.filter((r) => r.entry.category === 'compound');
    const blocked = compound.filter((r) => !r.wouldBeStored);
    expect(blocked.length).toBe(compound.length);
  });

  it('flags cross-site exfiltration attempts', () => {
    const crossSite = results.filter((r) => r.entry.category === 'cross-site-exfil');
    const flagged = crossSite.filter((r) => !r.wouldBeStored);
    expect(flagged.length).toBe(crossSite.length);
  });

  it('flags indirect injection attempts', () => {
    const indirect = results.filter((r) => r.entry.category === 'indirect-injection');
    const flagged = indirect.filter((r) => !r.wouldBeStored);
    expect(flagged.length).toBe(indirect.length);
  });

  it('average adversarial trust score is below 0.6', () => {
    const avgTrust = results.reduce((sum, r) => sum + r.trustScore, 0) / results.length;
    expect(avgTrust).toBeLessThan(0.6);
  });
});

describe('legitimate memory preservation', () => {
  const results = LEGITIMATE_ENTRIES.map(classifyEntry);

  it('has <5% false positive rate on legitimate memories', () => {
    const falsePositives = results.filter((r) => !r.wouldBeStored);
    const fpRate = falsePositives.length / results.length;
    expect(fpRate).toBeLessThan(0.05);
  });

  it('passes all legitimate memories through sanitizer', () => {
    const blocked = results.filter((r) => !r.sanitizationPassed);
    expect(blocked).toHaveLength(0);
  });

  it('assigns trust score >= threshold to all legitimate memories', () => {
    const belowThreshold = results.filter((r) => !r.meetsThreshold);
    expect(belowThreshold).toHaveLength(0);
  });

  it('passes security-related discussion topics without false positives', () => {
    const securityTopics = results.filter((r) =>
      r.entry.content.includes('injection') ||
      r.entry.content.includes('poisoning') ||
      r.entry.content.includes('A-MemGuard'),
    );
    expect(securityTopics.length).toBeGreaterThan(0);
    const blocked = securityTopics.filter((r) => !r.wouldBeStored);
    expect(blocked).toHaveLength(0);
  });

  it('passes edge-case entries that contain suspicious-looking words', () => {
    const edgeCases = results.filter((r) =>
      r.entry.content.includes('ignore') ||
      r.entry.content.includes('override') ||
      r.entry.content.includes('pretend') ||
      r.entry.content.includes('forget') ||
      r.entry.content.includes('replace'),
    );
    expect(edgeCases.length).toBeGreaterThan(0);
    const blocked = edgeCases.filter((r) => !r.wouldBeStored);
    expect(blocked).toHaveLength(0);
  });
});

describe('full dataset metrics (450+ legit, 30 adversarial)', () => {
  const { adversarial, legitimate } = buildFullDataset();
  const advResults = adversarial.map(classifyEntry);
  const legResults = legitimate.map(classifyEntry);

  it('has at least 30 adversarial entries', () => {
    expect(adversarial.length).toBeGreaterThanOrEqual(30);
  });

  it('has at least 90 legitimate entries', () => {
    expect(legitimate.length).toBeGreaterThanOrEqual(90);
  });

  it('achieves >90% adversarial blocking rate at scale', () => {
    const blocked = advResults.filter((r) => !r.wouldBeStored);
    const blockRate = blocked.length / advResults.length;
    expect(blockRate).toBeGreaterThanOrEqual(0.9);
  });

  it('achieves <5% false positive rate at scale', () => {
    const falsePositives = legResults.filter((r) => !r.wouldBeStored);
    const fpRate = falsePositives.length / legResults.length;
    expect(fpRate).toBeLessThan(0.05);
  });

  it('reports classification summary', () => {
    const advBlocked = advResults.filter((r) => !r.wouldBeStored).length;
    const legBlocked = legResults.filter((r) => !r.wouldBeStored).length;

    const summary = {
      adversarialTotal: adversarial.length,
      adversarialBlocked: advBlocked,
      adversarialBlockRate: `${((advBlocked / adversarial.length) * 100).toFixed(1)}%`,
      legitimateTotal: legitimate.length,
      legitimateFalsePositives: legBlocked,
      falsePositiveRate: `${((legBlocked / legitimate.length) * 100).toFixed(1)}%`,
    };

    console.log('Poisoning Suite Summary:', JSON.stringify(summary, null, 2));
    expect(summary).toBeDefined();
  });
});

describe('trust score distribution', () => {
  it('adversarial entries have lower average trust than legitimate', () => {
    const advScores = ADVERSARIAL_ENTRIES.map((e) => computeTrustScore(e.content, e.sourceSite).score);
    const legScores = LEGITIMATE_ENTRIES.map((e) => computeTrustScore(e.content, e.sourceSite).score);
    const avgAdv = advScores.reduce((sum, s) => sum + s, 0) / advScores.length;
    const avgLeg = legScores.reduce((sum, s) => sum + s, 0) / legScores.length;
    expect(avgAdv).toBeLessThan(avgLeg);
  });

  it('legitimate entries cluster near 1.0', () => {
    const scores = LEGITIMATE_ENTRIES.map((e) => computeTrustScore(e.content, e.sourceSite).score);
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    expect(avgScore).toBeGreaterThan(0.9);
  });

  it('adversarial entries from untrusted domains score below threshold', () => {
    const untrustedAdv = ADVERSARIAL_ENTRIES.filter((e) => !['claude.ai', 'chatgpt.com', 'github.com'].includes(e.sourceSite));
    const scores = untrustedAdv.map((e) => computeTrustScore(e.content, e.sourceSite).score);
    for (const score of scores) {
      expect(score).toBeLessThan(0.8);
    }
  });
});

describe('attack-specific blocking analysis', () => {
  // Categories blocked by sanitizer (injection patterns → block severity)
  const blockedCategories = [
    'instruction-override', 'role-override', 'format-injection',
    'stealth-instruction', 'persistent-override', 'compound',
    'unicode-obfuscation', 'cross-site-exfil', 'indirect-injection',
  ];

  // Categories flagged but not blocked (anomalies → warn severity, down-ranked at retrieval)
  const warnCategories = ['padding', 'oversized-payload'];

  for (const category of blockedCategories) {
    it(`blocks all ${category} attacks end-to-end`, () => {
      forEachAdversarialEntry(category, (entry) => {
        expect(classifyEntry(entry).wouldBeStored).toBe(false);
      });
    });
  }

  for (const category of warnCategories) {
    it(`flags ${category} attacks with warn severity and reduced trust`, () => {
      forEachAdversarialEntry(category, (entry) => {
        const trust = computeTrustScore(entry.content, entry.sourceSite);
        expect(trust.sanitization.highestSeverity).toBe('warn');
        expect(trust.score).toBeLessThan(1.0);
      });
    });
  }
});

/** Iterate over all adversarial entries in a category and run an assertion callback. */
function forEachAdversarialEntry(category: string, assertFn: (entry: PoisoningEntry) => void) {
  const entries = ADVERSARIAL_ENTRIES.filter((e) => e.category === category);
  for (const entry of entries) {
    assertFn(entry);
  }
}
