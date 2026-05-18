/**
 * @file AtomicMemory namespace lessons HTTP wiring
 *
 * Exercises each of the 4 lessons methods: list, stats, report, delete.
 * Core's lesson routes are user-scoped per memories.ts:352/362/372/385.
 * Tests verify request/response shape, snake→camel mapping on list,
 * optional argument handling on report, and the no-workspace-fields
 * guarantee.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import type {
  AtomicMemoryHandle,
  Lesson,
  LessonType,
} from '../handle';
import {
  installFetchMock,
  jsonResponse,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://example.invalid';
const USER_ID = 'u1';

function createHandle(): AtomicMemoryHandle {
  return new AtomicMemoryProvider({ apiUrl: API_URL }).getExtension<AtomicMemoryHandle>(
    'atomicmemory.base',
  )!;
}

function capturedCall(
  mockFetch: ReturnType<typeof vi.fn>,
): { url: string; body?: Record<string, unknown>; method?: string } {
  const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  const body =
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  return { url, body, method: init?.method };
}

let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockFetch = installFetchMock();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('atomicmemory.lessons.list', () => {
  const rawLesson = {
    id: 'lesson-1',
    user_id: USER_ID,
    lesson_type: 'user_reported',
    pattern: 'never claim I use Python 2',
    embedding: [0.1, 0.2, 0.3],
    source_memory_ids: ['mem-a', 'mem-b'],
    source_query: null,
    severity: 'medium',
    active: true,
    metadata: { note: 'user feedback' },
    created_at: '2026-04-01T00:00:00.000Z',
  };

  it('GETs /v1/memories/lessons with user_id query param', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ lessons: [rawLesson], count: 1 }),
    );

    const handle = createHandle();
    const result = await handle.lessons.list(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(`${API_URL}/v1/memories/lessons?user_id=${USER_ID}`);
    expect(result.count).toBe(1);
    expect(result.lessons).toHaveLength(1);
  });

  it('maps snake_case rows to camelCase and deserializes created_at', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ lessons: [rawLesson], count: 1 }),
    );
    const handle = createHandle();
    const result = await handle.lessons.list(USER_ID);
    const lesson: Lesson = result.lessons[0];

    expect(lesson.id).toBe('lesson-1');
    expect(lesson.userId).toBe(USER_ID);
    expect(lesson.lessonType).toBe('user_reported');
    expect(lesson.pattern).toBe('never claim I use Python 2');
    expect(lesson.sourceMemoryIds).toEqual(['mem-a', 'mem-b']);
    expect(lesson.sourceQuery).toBeNull();
    expect(lesson.severity).toBe('medium');
    expect(lesson.active).toBe(true);
    expect(lesson.metadata).toEqual({ note: 'user feedback' });
    expect(lesson.createdAt).toBeInstanceOf(Date);
    expect(lesson.createdAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('round-trips every LessonType variant core can emit', async () => {
    // Regression for the earlier SDK mismatch where the union missed
    // 'injection_blocked', 'false_memory', and 'contradiction_pattern'
    // (core: atomicmemory-core/src/db/repository-lessons.ts:16-22).
    const allTypes: LessonType[] = [
      'injection_blocked',
      'false_memory',
      'contradiction_pattern',
      'user_reported',
      'consensus_violation',
      'trust_violation',
    ];

    for (const lessonType of allTypes) {
      mockFetch = installFetchMock();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          lessons: [{ ...rawLesson, id: `l-${lessonType}`, lesson_type: lessonType }],
          count: 1,
        }),
      );
      const handle = createHandle();
      const result = await handle.lessons.list(USER_ID);
      expect(result.lessons[0].lessonType).toBe(lessonType);
    }
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

describe('atomicmemory.lessons.stats', () => {
  it('GETs /v1/memories/lessons/stats and maps snake_case to camelCase', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        total_active: 7,
        by_type: { user_reported: 3, contradiction: 2, trust_violation: 2 },
      }),
    );

    const handle = createHandle();
    const result = await handle.lessons.stats(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(
      `${API_URL}/v1/memories/lessons/stats?user_id=${USER_ID}`,
    );
    expect(result).toEqual({
      totalActive: 7,
      byType: { user_reported: 3, contradiction: 2, trust_violation: 2 },
    });
  });
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

describe('atomicmemory.lessons.report', () => {
  it('POSTs /v1/memories/lessons/report with minimal body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ lesson_id: 'new-lesson-1' }));
    const handle = createHandle();

    const result = await handle.lessons.report(USER_ID, 'avoid topic X');

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/memories/lessons/report`);
    expect(call.body).toEqual({
      user_id: USER_ID,
      pattern: 'avoid topic X',
    });
    expect(result).toEqual({ lessonId: 'new-lesson-1' });
  });

  it('forwards source_memory_ids when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ lesson_id: 'l2' }));
    const handle = createHandle();

    await handle.lessons.report(USER_ID, 'p', ['m1', 'm2']);

    const body = capturedCall(mockFetch).body!;
    expect(body.source_memory_ids).toEqual(['m1', 'm2']);
  });

  it('omits source_memory_ids when sources is an empty array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ lesson_id: 'l3' }));
    const handle = createHandle();
    await handle.lessons.report(USER_ID, 'p', []);
    expect(capturedCall(mockFetch).body?.source_memory_ids).toBeUndefined();
  });

  it('forwards severity when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ lesson_id: 'l4' }));
    const handle = createHandle();
    await handle.lessons.report(USER_ID, 'p', undefined, 'high');
    expect(capturedCall(mockFetch).body?.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('atomicmemory.lessons.delete', () => {
  it('DELETEs /v1/memories/lessons/:id with user_id query param', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const handle = createHandle();

    await handle.lessons.delete('lesson-xyz', USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe(
      `${API_URL}/v1/memories/lessons/lesson-xyz?user_id=${USER_ID}`,
    );
  });

  it('URL-encodes lessonId in the path', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const handle = createHandle();
    await handle.lessons.delete('lesson/with spaces', USER_ID);
    expect(capturedCall(mockFetch).url).toContain(
      '/v1/memories/lessons/lesson%2Fwith%20spaces',
    );
  });
});

// ---------------------------------------------------------------------------
// Workspace contamination guard
// ---------------------------------------------------------------------------

describe('lessons methods never emit workspace fields on the wire', () => {
  it('every method keeps workspace_id / agent_id / agent_scope off the wire', async () => {
    const handle = createHandle();

    // list
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(jsonResponse({ lessons: [], count: 0 }));
    await handle.lessons.list(USER_ID);
    assertCleanCall(mockFetch);

    // stats
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ total_active: 0, by_type: {} }),
    );
    await handle.lessons.stats(USER_ID);
    assertCleanCall(mockFetch);

    // report
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(jsonResponse({ lesson_id: 'l' }));
    await handle.lessons.report(USER_ID, 'p', ['m1'], 'low');
    assertCleanCall(mockFetch);

    // delete
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    await handle.lessons.delete('l1', USER_ID);
    assertCleanCall(mockFetch);
  });
});

function assertCleanCall(mockFetch: ReturnType<typeof vi.fn>): void {
  const call = capturedCall(mockFetch);
  expect(call.url).not.toContain('workspace_id');
  expect(call.url).not.toContain('agent_id');
  expect(call.url).not.toContain('agent_scope');
  if (call.body) {
    expect(call.body.workspace_id).toBeUndefined();
    expect(call.body.agent_id).toBeUndefined();
    expect(call.body.agent_scope).toBeUndefined();
  }
}
