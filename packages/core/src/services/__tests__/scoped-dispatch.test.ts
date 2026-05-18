/**
 * Behavioral tests for scope-dispatching methods on MemoryService.
 *
 * Verifies that scopedSearch and scopedExpand route to the correct
 * internal implementation based on scope.kind.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPerformSearch, mockPerformFastSearch, mockPerformWorkspaceSearch } = vi.hoisted(() => ({
  mockPerformSearch: vi.fn(),
  mockPerformFastSearch: vi.fn(),
  mockPerformWorkspaceSearch: vi.fn(),
}));
const { mockExpandMemories, mockExpandInWorkspace } = vi.hoisted(() => ({
  mockExpandMemories: vi.fn(),
  mockExpandInWorkspace: vi.fn(),
}));
const { mockListMemories, mockListInWorkspace } = vi.hoisted(() => ({
  mockListMemories: vi.fn(),
  mockListInWorkspace: vi.fn(),
}));

vi.mock('../memory-search.js', () => ({
  performSearch: mockPerformSearch,
  performFastSearch: mockPerformFastSearch,
  performWorkspaceSearch: mockPerformWorkspaceSearch,
}));
vi.mock('../memory-ingest.js', () => ({
  performIngest: vi.fn(),
  performQuickIngest: vi.fn(),
  performStoreVerbatim: vi.fn(),
  performWorkspaceIngest: vi.fn(),
}));
vi.mock('../memory-crud.js', () => ({
  expandMemories: mockExpandMemories,
  expandMemoriesInWorkspace: mockExpandInWorkspace,
  listMemories: mockListMemories,
  listMemoriesInWorkspace: mockListInWorkspace,
  getMemory: vi.fn(),
  getMemoryInWorkspace: vi.fn(),
  deleteMemory: vi.fn(),
  deleteMemoryInWorkspace: vi.fn(),
  resetBySource: vi.fn(),
  getStats: vi.fn(),
  consolidate: vi.fn(),
  performExecuteConsolidation: vi.fn(),
  reconcileDeferred: vi.fn(),
  reconcileDeferredAll: vi.fn(),
  getDeferredStatus: vi.fn(),
  evaluateDecay: vi.fn(),
  archiveDecayed: vi.fn(),
  checkCap: vi.fn(),
  getAuditTrail: vi.fn(),
  getMutationSummary: vi.fn(),
  getRecentMutations: vi.fn(),
  backfillClaimSlots: vi.fn(),
  getReversalChain: vi.fn(),
  getLessons: vi.fn(),
  getLessonStats: vi.fn(),
  reportLesson: vi.fn(),
  deactivateLesson: vi.fn(),
}));
vi.mock('../../config.js', () => ({ config: {} }));
vi.mock('../observation-service.js', () => ({ ObservationService: vi.fn() }));
vi.mock('../atomicmem-uri.js', () => ({ URIResolver: vi.fn() }));

const { MemoryService } = await import('../memory-service.js');

const searchResult = { memories: [], scope: { kind: 'user', userId: 'u1' } };

describe('scopedSearch', () => {
  let service: InstanceType<typeof MemoryService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MemoryService({} as any, {} as any);
    mockPerformSearch.mockResolvedValue(searchResult);
    mockPerformFastSearch.mockResolvedValue(searchResult);
    mockPerformWorkspaceSearch.mockResolvedValue(searchResult);
  });

  it('dispatches user scope to performSearch', async () => {
    await service.scopedSearch({ kind: 'user', userId: 'u1' }, 'query', { sourceSite: 'test', limit: 5 });
    expect(mockPerformSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'u1', query: 'query', sourceSite: 'test', limit: 5 }),
    );
    expect(mockPerformWorkspaceSearch).not.toHaveBeenCalled();
  });

  it('dispatches user scope with fast option to performFastSearch', async () => {
    await service.scopedSearch({ kind: 'user', userId: 'u1' }, 'query', { fast: true, sourceSite: 'test', limit: 10 });
    expect(mockPerformFastSearch).toHaveBeenCalledWith(expect.anything(), 'u1', 'query', 'test', 10, undefined, undefined, undefined);
    expect(mockPerformSearch).not.toHaveBeenCalled();
  });

  it('dispatches workspace scope to performWorkspaceSearch with agentId', async () => {
    await service.scopedSearch(
      { kind: 'workspace', userId: 'u1', workspaceId: 'ws1', agentId: 'a1', agentScope: 'self' },
      'query', { limit: 8 },
    );
    expect(mockPerformWorkspaceSearch).toHaveBeenCalledWith(
      expect.anything(), 'u1', 'query',
      { workspaceId: 'ws1', agentId: 'a1' },
      expect.objectContaining({ agentScope: 'self', limit: 8 }),
    );
    expect(mockPerformSearch).not.toHaveBeenCalled();
  });

  it('forwards workspace sessionId to performWorkspaceSearch', async () => {
    await service.scopedSearch(
      { kind: 'workspace', userId: 'u1', workspaceId: 'ws1', agentId: 'a1' },
      'query',
      { sessionId: 'thread-1' },
    );
    expect(mockPerformWorkspaceSearch).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'query',
      { workspaceId: 'ws1', agentId: 'a1' },
      expect.objectContaining({ sessionId: 'thread-1' }),
    );
  });
});

describe('scopedList', () => {
  let service: InstanceType<typeof MemoryService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MemoryService({} as any, {} as any);
    mockListMemories.mockResolvedValue([]);
    mockListInWorkspace.mockResolvedValue([]);
  });

  it('forwards user list options to listMemories', async () => {
    await service.list({
      userId: 'u1',
      limit: 7,
      offset: 2,
      sourceSite: 'site-1',
      episodeId: 'episode-1',
      sessionId: 'thread-user',
    });

    expect(mockListMemories).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      7,
      2,
      'site-1',
      'episode-1',
      'thread-user',
    );
  });

  it('forwards workspace sessionId to listMemoriesInWorkspace', async () => {
    await service.scopedList({
      scope: { kind: 'workspace', userId: 'u1', workspaceId: 'ws1', agentId: 'a1' },
      limit: 20,
      offset: 0,
      sessionId: 'thread-1',
    });
    expect(mockListInWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      'ws1',
      20,
      0,
      'a1',
      'thread-1',
    );
  });
});

describe('scopedExpand', () => {
  let service: InstanceType<typeof MemoryService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MemoryService({} as any, {} as any);
    mockExpandMemories.mockResolvedValue([]);
    mockExpandInWorkspace.mockResolvedValue([]);
  });

  it('dispatches user scope to expandMemories', async () => {
    await service.scopedExpand({ kind: 'user', userId: 'u1' }, ['m1']);
    expect(mockExpandMemories).toHaveBeenCalledWith(expect.anything(), 'u1', ['m1']);
    expect(mockExpandInWorkspace).not.toHaveBeenCalled();
  });

  it('dispatches workspace scope to expandMemoriesInWorkspace', async () => {
    await service.scopedExpand(
      { kind: 'workspace', userId: 'u1', workspaceId: 'ws1', agentId: 'a1' }, ['m1'],
    );
    expect(mockExpandInWorkspace).toHaveBeenCalledWith(expect.anything(), 'ws1', ['m1'], 'a1');
    expect(mockExpandMemories).not.toHaveBeenCalled();
  });
});
