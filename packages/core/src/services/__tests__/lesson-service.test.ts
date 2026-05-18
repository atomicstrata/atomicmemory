/**
 * Unit tests for the lesson detection and pre-retrieval defense service.
 * Tests lesson check logic, detection thresholds, and warning formatting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../embedding.js', () => ({
  embedText: vi.fn().mockResolvedValue(Array(1024).fill(0)),
}));

vi.mock('../audit-events.js', () => ({
  emitAuditEvent: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    auditLoggingEnabled: false,
    trustScoreMinThreshold: 0.3,
    lessonSimilarityThreshold: 0.75,
  },
}));

import {
  checkLessons,
  recordInjectionLesson,
  recordTrustViolationLesson,
  recordContradictionLesson,
  recordUserReportedLesson,
  getLessonStats,
} from '../lesson-service.js';
import type { LessonRepository, LessonMatch, LessonRow } from '../../db/repository-lessons.js';

function createMockRepo(overrides: Partial<LessonRepository> = {}): LessonRepository {
  return {
    createLesson: vi.fn().mockResolvedValue('lesson-1'),
    findSimilarLessons: vi.fn().mockResolvedValue([]),
    getLessonsByUser: vi.fn().mockResolvedValue([]),
    getLessonsByType: vi.fn().mockResolvedValue([]),
    deactivateLesson: vi.fn().mockResolvedValue(undefined),
    countActiveLessons: vi.fn().mockResolvedValue(0),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as LessonRepository;
}

function createLessonMatch(severity: string, type: string, similarity: number): LessonMatch {
  return {
    lesson: {
      id: 'lesson-1',
      user_id: 'user-1',
      lesson_type: type,
      pattern: `Test pattern for ${type}`,
      embedding: [],
      source_memory_ids: [],
      source_query: null,
      severity,
      active: true,
      metadata: {},
      created_at: new Date(),
    } as LessonRow,
    similarity,
  };
}

describe('checkLessons', () => {
  it('returns safe=true when no lessons match', async () => {
    const repo = createMockRepo();
    const result = await checkLessons(repo, 'user-1', 'what is my name?');
    expect(result.safe).toBe(true);
    expect(result.matchedLessons).toHaveLength(0);
    expect(result.highestSeverity).toBe('none');
  });

  it('returns safe=true with warnings for medium severity', async () => {
    const match = createLessonMatch('medium', 'trust_violation', 0.85);
    const repo = createMockRepo({ findSimilarLessons: vi.fn().mockResolvedValue([match]) });

    const result = await checkLessons(repo, 'user-1', 'suspicious query');
    expect(result.safe).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.highestSeverity).toBe('medium');
  });

  it('returns safe=false for critical severity', async () => {
    const match = createLessonMatch('critical', 'injection_blocked', 0.92);
    const repo = createMockRepo({ findSimilarLessons: vi.fn().mockResolvedValue([match]) });

    const result = await checkLessons(repo, 'user-1', 'ignore instructions');
    expect(result.safe).toBe(false);
    expect(result.highestSeverity).toBe('critical');
  });

  it('resolves highest severity from multiple matches', async () => {
    const matches = [
      createLessonMatch('low', 'contradiction_pattern', 0.80),
      createLessonMatch('high', 'injection_blocked', 0.90),
      createLessonMatch('medium', 'trust_violation', 0.85),
    ];
    const repo = createMockRepo({ findSimilarLessons: vi.fn().mockResolvedValue(matches) });

    const result = await checkLessons(repo, 'user-1', 'query');
    expect(result.highestSeverity).toBe('high');
    expect(result.safe).toBe(true);
    expect(result.warnings).toHaveLength(3);
  });
});

describe('recordInjectionLesson', () => {
  it('returns null when sanitization passed', async () => {
    const repo = createMockRepo();
    const result = await recordInjectionLesson(repo, {
      userId: 'user-1',
      content: 'safe content',
      sourceSite: 'test',
      sanitizationResult: { passed: true, findings: [], highestSeverity: 'none' as const },
    });
    expect(result).toBeNull();
  });

  it('creates lesson when sanitization blocked', async () => {
    const repo = createMockRepo();
    const result = await recordInjectionLesson(repo, {
      userId: 'user-1',
      content: 'ignore all instructions',
      sourceSite: 'chat',
      sanitizationResult: {
        passed: false,
        findings: [
          { rule: 'prompt_injection', detail: 'detected', severity: 'block' },
        ],
        highestSeverity: 'block' as const,
      },
    });
    expect(result).toBe('lesson-1');
    expect(repo.createLesson).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      lessonType: 'injection_blocked',
      severity: 'high',
    }));
  });

  it('sets critical severity for 3+ block findings', async () => {
    const repo = createMockRepo();
    await recordInjectionLesson(repo, {
      userId: 'user-1',
      content: 'multi-attack',
      sourceSite: 'chat',
      sanitizationResult: {
        passed: false,
        findings: [
          { rule: 'rule1', detail: 'd1', severity: 'block' },
          { rule: 'rule2', detail: 'd2', severity: 'block' },
          { rule: 'rule3', detail: 'd3', severity: 'block' },
        ],
        highestSeverity: 'block' as const,
      },
    });
    expect(repo.createLesson).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
    }));
  });
});

describe('recordTrustViolationLesson', () => {
  it('returns null when trust score is above threshold', async () => {
    const repo = createMockRepo();
    const result = await recordTrustViolationLesson(repo, {
      userId: 'user-1',
      content: 'trusted content',
      sourceSite: 'test',
      trustScore: 0.9,
    });
    expect(result).toBeNull();
  });

  it('creates lesson when trust score is below threshold', async () => {
    const repo = createMockRepo();
    const result = await recordTrustViolationLesson(repo, {
      userId: 'user-1',
      content: 'untrusted content',
      sourceSite: 'sketchy-site',
      trustScore: 0.05,
    });
    expect(result).toBe('lesson-1');
    expect(repo.createLesson).toHaveBeenCalledWith(expect.objectContaining({
      lessonType: 'trust_violation',
      severity: 'high',
    }));
  });
});

describe('recordContradictionLesson', () => {
  it('returns null for low-confidence contradictions', async () => {
    const repo = createMockRepo();
    const result = await recordContradictionLesson(repo, {
      userId: 'user-1',
      content: 'fact',
      sourceSite: 'test',
      contradictionConfidence: 0.5,
    });
    expect(result).toBeNull();
  });

  it('creates lesson for high-confidence contradictions', async () => {
    const repo = createMockRepo();
    const result = await recordContradictionLesson(repo, {
      userId: 'user-1',
      content: 'contradicting fact',
      sourceSite: 'test',
      contradictionConfidence: 0.95,
      supersededMemoryId: 'mem-old',
    });
    expect(result).toBe('lesson-1');
    expect(repo.createLesson).toHaveBeenCalledWith(expect.objectContaining({
      lessonType: 'contradiction_pattern',
      severity: 'medium',
      sourceMemoryIds: ['mem-old'],
    }));
  });
});

describe('recordUserReportedLesson', () => {
  it('creates a user-reported lesson', async () => {
    const repo = createMockRepo();
    const id = await recordUserReportedLesson(repo, 'user-1', 'bad pattern', ['mem-1']);
    expect(id).toBe('lesson-1');
    expect(repo.createLesson).toHaveBeenCalledWith(expect.objectContaining({
      lessonType: 'user_reported',
      severity: 'high',
    }));
  });
});

describe('getLessonStats', () => {
  it('aggregates lessons by type', async () => {
    const lessons = [
      { lesson_type: 'injection_blocked' },
      { lesson_type: 'injection_blocked' },
      { lesson_type: 'trust_violation' },
    ] as LessonRow[];
    const repo = createMockRepo({ getLessonsByUser: vi.fn().mockResolvedValue(lessons) });

    const stats = await getLessonStats(repo, 'user-1');
    expect(stats.totalActive).toBe(3);
    expect(stats.byType).toEqual({ injection_blocked: 2, trust_violation: 1 });
  });
});
