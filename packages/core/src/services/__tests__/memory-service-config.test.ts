/**
 * MemoryService config seam tests.
 *
 * Verifies that the service can thread an explicit runtime config into its
 * delegated modules while preserving the current singleton default when no
 * override is provided.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPerformSearch,
  mockPerformIngest,
  mockPerformQuickIngest,
  mockPerformStoreVerbatim,
  mockPerformWorkspaceIngest,
} = vi.hoisted(() => ({
  mockPerformSearch: vi.fn(),
  mockPerformIngest: vi.fn(),
  mockPerformQuickIngest: vi.fn(),
  mockPerformStoreVerbatim: vi.fn(),
  mockPerformWorkspaceIngest: vi.fn(),
}));

const moduleConfig = {
  lessonsEnabled: true,
  consensusValidationEnabled: true,
  consensusMinMemories: 2,
  auditLoggingEnabled: true,
};

vi.mock('../../config.js', () => ({ config: moduleConfig }));
vi.mock('../memory-ingest.js', () => ({
  performIngest: mockPerformIngest,
  performQuickIngest: mockPerformQuickIngest,
  performStoreVerbatim: mockPerformStoreVerbatim,
  performWorkspaceIngest: mockPerformWorkspaceIngest,
}));
vi.mock('../memory-search.js', () => ({
  performSearch: mockPerformSearch,
  performFastSearch: vi.fn(),
  performWorkspaceSearch: vi.fn(),
}));
vi.mock('../memory-crud.js', () => ({}));
vi.mock('../atomicmem-uri.js', () => ({
  URIResolver: class {
    resolve = vi.fn();
    format = vi.fn();
  },
}));

const { MemoryService } = await import('../memory-service.js');

describe('MemoryService config seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('threads an explicit runtime config into delegated search deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    mockPerformSearch.mockResolvedValue({
      memories: [],
      injectionText: '',
      citations: [],
      retrievalMode: 'flat',
      budgetConstrained: false,
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    await service.search('user-1', 'config seam query');

    expect(mockPerformSearch).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      expect.objectContaining({ userId: 'user-1', query: 'config seam query' }),
    );
  });

  it('threads an explicit runtime config into delegated ingest deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    mockPerformIngest.mockResolvedValue({
      episodeId: 'ep-1',
      factsExtracted: 0,
      stored: 0,
      skipped: 0,
      linksCreated: 0,
      compositesCreated: 0,
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    await service.ingest({
      userId: 'user-1',
      conversationText: 'text',
      sourceSite: 'site',
    });

    expect(mockPerformIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      'user-1',
      'text',
      'site',
      '',
      undefined,
      undefined,
    );
  });

  it('forwards named ingest input without positional ambiguity', async () => {
    const effectiveConfig = { ...moduleConfig, ingestTraceEnabled: true };
    const sessionTimestamp = new Date('2026-05-16T12:00:00.000Z');
    mockPerformIngest.mockResolvedValue({ episodeId: 'ep-1' });
    const service = new MemoryService({} as any, {} as any);

    await service.ingest({
      userId: 'user-1',
      conversationText: 'text',
      sourceSite: 'site',
      sourceUrl: 'https://example.test/thread',
      sessionTimestamp,
      sessionId: 'thread-1',
      effectiveConfig: effectiveConfig as any,
    });

    expect(mockPerformIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: effectiveConfig }),
      'user-1',
      'text',
      'site',
      'https://example.test/thread',
      sessionTimestamp,
      'thread-1',
    );
  });

  it('threads an explicit runtime config into delegated quick-ingest deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    mockPerformQuickIngest.mockResolvedValue({
      episodeId: 'ep-1',
      factsExtracted: 0,
      stored: 0,
      skipped: 0,
      linksCreated: 0,
      compositesCreated: 0,
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    await service.quickIngest({
      userId: 'user-1',
      conversationText: 'text',
      sourceSite: 'site',
    });

    expect(mockPerformQuickIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      'user-1',
      'text',
      'site',
      '',
      undefined,
      undefined,
    );
  });

  it('forwards named quick-ingest input without positional ambiguity', async () => {
    const effectiveConfig = { ...moduleConfig, entropyGateEnabled: false };
    const sessionTimestamp = new Date('2026-05-16T12:30:00.000Z');
    mockPerformQuickIngest.mockResolvedValue({ episodeId: 'ep-1' });
    const service = new MemoryService({} as any, {} as any);

    await service.quickIngest({
      userId: 'user-1',
      conversationText: 'quick text',
      sourceSite: 'quick-site',
      sourceUrl: 'https://example.test/quick',
      sessionTimestamp,
      sessionId: 'thread-quick',
      effectiveConfig: effectiveConfig as any,
    });

    expect(mockPerformQuickIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: effectiveConfig }),
      'user-1',
      'quick text',
      'quick-site',
      'https://example.test/quick',
      sessionTimestamp,
      'thread-quick',
    );
  });

  it('forwards named store-verbatim input without positional ambiguity', async () => {
    const effectiveConfig = { ...moduleConfig, ingestTraceEnabled: true };
    const metadata = { source: 'test' };
    mockPerformStoreVerbatim.mockResolvedValue({ episodeId: 'ep-1' });
    const service = new MemoryService({} as any, {} as any);

    await service.storeVerbatim({
      userId: 'user-1',
      content: 'verbatim text',
      sourceSite: 'verbatim-site',
      sourceUrl: 'https://example.test/verbatim',
      metadata,
      sessionId: 'thread-verbatim',
      effectiveConfig: effectiveConfig as any,
    });

    expect(mockPerformStoreVerbatim).toHaveBeenCalledWith(
      expect.objectContaining({ config: effectiveConfig }),
      'user-1',
      'verbatim text',
      'verbatim-site',
      'https://example.test/verbatim',
      metadata,
      'thread-verbatim',
    );
  });

  it('threads an explicit runtime config into delegated workspace-ingest deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    const workspace = {
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      visibility: 'workspace',
    };
    mockPerformWorkspaceIngest.mockResolvedValue({
      episodeId: 'ep-1',
      factsExtracted: 0,
      stored: 0,
      skipped: 0,
      linksCreated: 0,
      compositesCreated: 0,
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    const sessionTimestamp = new Date('2026-05-16T13:00:00.000Z');

    await service.workspaceIngest({
      userId: 'user-1',
      conversationText: 'text',
      sourceSite: 'site',
      sourceUrl: 'https://example.test/workspace',
      sessionTimestamp,
      sessionId: 'thread-workspace',
      workspace: workspace as any,
    });

    expect(mockPerformWorkspaceIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      'user-1',
      'text',
      'site',
      'https://example.test/workspace',
      workspace,
      sessionTimestamp,
      'thread-workspace',
    );
  });

  it('defaults delegated search deps to the module config singleton', async () => {
    mockPerformSearch.mockResolvedValue({
      memories: [],
      injectionText: '',
      citations: [],
      retrievalMode: 'flat',
      budgetConstrained: false,
    });
    const service = new MemoryService({} as any, {} as any);

    await service.search('user-1', 'default config query');

    expect(mockPerformSearch).toHaveBeenCalledWith(
      expect.objectContaining({ config: moduleConfig }),
      expect.objectContaining({ userId: 'user-1', query: 'default config query' }),
    );
  });
});
