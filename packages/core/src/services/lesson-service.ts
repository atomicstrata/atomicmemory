/**
 * Lesson detection and pre-retrieval defense service.
 *
 * Implements A-MemGuard's self-reinforcing defense:
 *   1. Detect failure patterns during ingest (sanitizer blocks, trust violations,
 *      high-confidence contradictions) and store as lessons.
 *   2. Before retrieval, check query against known lessons to warn or block.
 *
 * Phase 6 security layer — builds on Phase 3 trust scoring and sanitization.
 */

import { embedText } from './embedding.js';
import { emitAuditEvent } from './audit-events.js';
import { config } from '../config.js';
import type { LessonRow, LessonMatch, LessonSeverity, LessonType } from '../db/repository-lessons.js';
import type { LessonStore } from '../db/stores.js';
import type { SanitizationResult } from './input-sanitizer.js';
import type { ConsensusResult } from './consensus-validation.js';
import type { SearchResult } from '../db/repository-types.js';

/** Result of a pre-retrieval lesson check. */
export interface LessonCheckResult {
  safe: boolean;
  matchedLessons: LessonMatch[];
  warnings: string[];
  highestSeverity: LessonSeverity | 'none';
}

/** Lesson detection context passed from the ingest pipeline. */
export interface LessonDetectionContext {
  userId: string;
  content: string;
  sourceSite: string;
  sanitizationResult?: SanitizationResult;
  trustScore?: number;
  contradictionConfidence?: number;
  supersededMemoryId?: string;
}

const LESSON_SIMILARITY_THRESHOLD = 0.75;
const LESSON_CHECK_LIMIT = 3;

/**
 * Check a query against known lessons before returning retrieval results.
 * Returns warnings for medium/high severity, blocks on critical.
 */
export async function checkLessons(
  repo: LessonStore,
  userId: string,
  query: string,
): Promise<LessonCheckResult> {
  const embedding = await embedText(query);
  const matches = await repo.findSimilarLessons(userId, embedding, LESSON_SIMILARITY_THRESHOLD, LESSON_CHECK_LIMIT);

  if (matches.length === 0) {
    return { safe: true, matchedLessons: [], warnings: [], highestSeverity: 'none' };
  }

  const warnings = matches.map((m) => formatLessonWarning(m));
  const highestSeverity = resolveHighestSeverity(matches.map((m) => m.lesson.severity));
  const safe = highestSeverity !== 'critical';

  if (config.auditLoggingEnabled) {
    emitAuditEvent('lesson:match', userId, {
      query: query.slice(0, 200),
      matchCount: matches.length,
      highestSeverity,
      safe,
    });
  }

  return { safe, matchedLessons: matches, warnings, highestSeverity };
}

/**
 * Detect and store a lesson from a sanitization block.
 * Called when input sanitizer catches an injection attempt.
 */
export async function recordInjectionLesson(
  repo: LessonStore,
  ctx: LessonDetectionContext,
): Promise<string | null> {
  if (!ctx.sanitizationResult || ctx.sanitizationResult.passed) return null;

  const blockFindings = ctx.sanitizationResult.findings.filter((f) => f.severity === 'block');
  if (blockFindings.length === 0) return null;

  const pattern = buildInjectionPattern(ctx.content, blockFindings);
  const embedding = await embedText(pattern);
  const severity = blockFindings.length >= 3 ? 'critical' : 'high';

  const lessonId = await repo.createLesson({
    userId: ctx.userId,
    lessonType: 'injection_blocked',
    pattern,
    embedding,
    severity,
    metadata: {
      sourceSite: ctx.sourceSite,
      findingCount: blockFindings.length,
      rules: blockFindings.map((f) => f.rule),
    },
  });

  emitLessonAuditEvent(ctx.userId, 'injection_blocked', lessonId, severity);
  return lessonId;
}

/**
 * Detect and store a lesson from a trust score violation.
 * Called when a fact is rejected for being below the trust threshold.
 */
export async function recordTrustViolationLesson(
  repo: LessonStore,
  ctx: LessonDetectionContext,
): Promise<string | null> {
  if (ctx.trustScore === undefined || ctx.trustScore >= config.trustScoreMinThreshold) return null;

  const pattern = `Low-trust content from ${ctx.sourceSite}: "${ctx.content.slice(0, 200)}"`;
  const embedding = await embedText(pattern);

  const lessonId = await repo.createLesson({
    userId: ctx.userId,
    lessonType: 'trust_violation',
    pattern,
    embedding,
    severity: ctx.trustScore < 0.1 ? 'high' : 'medium',
    metadata: {
      sourceSite: ctx.sourceSite,
      trustScore: ctx.trustScore,
      threshold: config.trustScoreMinThreshold,
    },
  });

  emitLessonAuditEvent(ctx.userId, 'trust_violation', lessonId, 'medium');
  return lessonId;
}

/**
 * Detect and store a lesson from a high-confidence contradiction.
 * Called when SUPERSEDE or DELETE fires with high contradiction confidence.
 */
export async function recordContradictionLesson(
  repo: LessonStore,
  ctx: LessonDetectionContext,
): Promise<string | null> {
  if (!ctx.contradictionConfidence || ctx.contradictionConfidence < 0.8) return null;

  const pattern = `High-confidence contradiction (${ctx.contradictionConfidence.toFixed(2)}): "${ctx.content.slice(0, 200)}"`;
  const embedding = await embedText(pattern);

  const lessonId = await repo.createLesson({
    userId: ctx.userId,
    lessonType: 'contradiction_pattern',
    pattern,
    embedding,
    sourceMemoryIds: ctx.supersededMemoryId ? [ctx.supersededMemoryId] : [],
    severity: 'medium',
    metadata: {
      contradictionConfidence: ctx.contradictionConfidence,
      supersededMemoryId: ctx.supersededMemoryId,
    },
  });

  emitLessonAuditEvent(ctx.userId, 'contradiction_pattern', lessonId, 'medium');
  return lessonId;
}

/**
 * Record a user-reported lesson (explicit feedback that a memory was wrong).
 */
export async function recordUserReportedLesson(
  repo: LessonStore,
  userId: string,
  pattern: string,
  sourceMemoryIds: string[],
  severity: LessonSeverity = 'high',
): Promise<string> {
  const embedding = await embedText(pattern);
  const lessonId = await repo.createLesson({
    userId,
    lessonType: 'user_reported',
    pattern,
    embedding,
    sourceMemoryIds,
    severity,
  });

  emitLessonAuditEvent(userId, 'user_reported', lessonId, severity);
  return lessonId;
}

/** Get all active lessons for a user. */
export async function getUserLessons(repo: LessonStore, userId: string): Promise<LessonRow[]> {
  return repo.getLessonsByUser(userId);
}

/** Get lesson stats for a user. */
export async function getLessonStats(
  repo: LessonStore,
  userId: string,
): Promise<{ totalActive: number; byType: Record<string, number> }> {
  const lessons = await repo.getLessonsByUser(userId);
  const byType: Record<string, number> = {};
  for (const lesson of lessons) {
    byType[lesson.lesson_type] = (byType[lesson.lesson_type] ?? 0) + 1;
  }
  return { totalActive: lessons.length, byType };
}

function formatLessonWarning(match: LessonMatch): string {
  return `[${match.lesson.severity}] ${match.lesson.lesson_type}: ${match.lesson.pattern.slice(0, 100)} (similarity: ${match.similarity.toFixed(2)})`;
}

function resolveHighestSeverity(severities: LessonSeverity[]): LessonSeverity {
  const order: LessonSeverity[] = ['low', 'medium', 'high', 'critical'];
  let highest = 0;
  for (const s of severities) {
    const idx = order.indexOf(s);
    if (idx > highest) highest = idx;
  }
  return order[highest];
}

function buildInjectionPattern(content: string, findings: Array<{ rule: string; detail: string }>): string {
  const rules = findings.map((f) => f.rule).join(', ');
  return `Injection attempt blocked (${rules}): "${content.slice(0, 200)}"`;
}

function emitLessonAuditEvent(userId: string, lessonType: LessonType, lessonId: string, severity: string): void {
  if (!config.auditLoggingEnabled) return;
  emitAuditEvent('lesson:created', userId, { lessonType, severity }, { lessonId });
}

/**
 * Record lessons for memories removed by consensus validation.
 * Creates a `consensus_violation` lesson for each divergent memory.
 */
export async function recordConsensusLessons(
  lessons: LessonStore,
  userId: string,
  result: ConsensusResult,
  memories: SearchResult[],
): Promise<void> {
  for (const judgment of result.judgments) {
    if (judgment.aligned) continue;
    const memory = memories.find((m) => m.id === judgment.memoryId);
    const pattern = `Consensus violation: "${memory?.content.slice(0, 150) ?? judgment.memoryId}" — ${judgment.divergenceReason}`;
    await recordUserReportedLesson(
      lessons, userId, pattern, [judgment.memoryId], 'medium',
    );
  }
}
