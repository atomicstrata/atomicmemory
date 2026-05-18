/**
 * Shared write-time security gate for memory ingest paths.
 *
 * Centralizes sanitization/trust enforcement so standard and hive ingest flows
 * cannot diverge on whether unsafe content is allowed into storage.
 */

import type { LessonStore } from '../db/stores.js';
import { emitAuditEvent } from './audit-events.js';
import { recordInjectionLesson, recordTrustViolationLesson } from './lesson-service.js';
import { computeTrustScore, meetsMinimumTrust, type TrustScore } from './trust-scoring.js';

export type WriteBlockReason = 'sanitization' | 'trust' | null;

export interface WriteSecurityDecision {
  allowed: boolean;
  blockedBy: WriteBlockReason;
  trust: TrustScore;
}

/**
 * Config subset consumed by assessWriteSecurity. Narrow `Pick<>` of
 * IngestRuntimeConfig so callers only need to thread what the function
 * actually reads.
 */
export interface WriteSecurityAssessConfig {
  trustScoringEnabled: boolean;
  trustScoreMinThreshold: number;
}

/** Config subset consumed by recordRejectedWrite. */
export interface WriteSecurityRecordConfig {
  auditLoggingEnabled: boolean;
  lessonsEnabled: boolean;
  trustScoreMinThreshold: number;
}

export function assessWriteSecurity(
  content: string,
  sourceSite: string,
  config: WriteSecurityAssessConfig,
): WriteSecurityDecision {
  const trust = config.trustScoringEnabled
    ? computeTrustScore(content, sourceSite)
    : PASS_THROUGH_TRUST;

  if (!config.trustScoringEnabled) {
    return { allowed: true, blockedBy: null, trust };
  }
  if (!trust.sanitization.passed) {
    return { allowed: false, blockedBy: 'sanitization', trust };
  }
  if (!meetsMinimumTrust(trust, config.trustScoreMinThreshold)) {
    return { allowed: false, blockedBy: 'trust', trust };
  }
  return { allowed: true, blockedBy: null, trust };
}

export async function recordRejectedWrite(
  userId: string,
  content: string,
  sourceSite: string,
  decision: WriteSecurityDecision,
  config: WriteSecurityRecordConfig,
  lessons?: LessonStore | null,
): Promise<void> {
  if (config.auditLoggingEnabled && !decision.trust.sanitization.passed) {
    emitAuditEvent('sanitization:block', userId, {
      fact: content.slice(0, 200),
      findings: decision.trust.sanitization.findings,
    }, { sourceSite });
  }

  if (config.lessonsEnabled && lessons && !decision.trust.sanitization.passed) {
    await recordInjectionLesson(lessons, {
      userId,
      content,
      sourceSite,
      sanitizationResult: decision.trust.sanitization,
    });
  }

  if (decision.blockedBy !== 'trust') return;

  if (config.auditLoggingEnabled) {
    emitAuditEvent('trust:below-threshold', userId, {
      fact: content.slice(0, 200),
      trustScore: decision.trust.score,
      threshold: config.trustScoreMinThreshold,
    }, { sourceSite });
  }

  if (config.lessonsEnabled && lessons) {
    await recordTrustViolationLesson(lessons, {
      userId,
      content,
      sourceSite,
      trustScore: decision.trust.score,
    });
  }
}

const PASS_THROUGH_TRUST: TrustScore = {
  score: 1.0,
  domainTrust: 1.0,
  contentPenalty: 0,
  injectionPenalty: 0,
  sanitization: { passed: true, findings: [], highestSeverity: 'none' },
};
