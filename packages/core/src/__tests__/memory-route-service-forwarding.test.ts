/**
 * Route-to-service forwarding tests for object-shaped MemoryService calls.
 *
 * These guard against regressions where route handlers reintroduce
 * positional `undefined, undefined, sessionId` plumbing after the
 * service facade moved high-risk write/list calls to named inputs.
 */

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService } from '../services/memory-service.js';

const EMPTY_INGEST = {
  episodeId: 'ep',
  factsExtracted: 0,
  memoriesStored: 0,
  memoriesUpdated: 0,
  memoriesDeleted: 0,
  memoriesSkipped: 0,
  storedMemoryIds: [],
  updatedMemoryIds: [],
  memoryIds: [],
  linksCreated: 0,
  compositesCreated: 0,
};

describe('memory routes — object-shaped service forwarding', () => {
  let booted: BootedApp;
  const mockScopedSearch = vi.fn<MemoryService['scopedSearch']>();
  const mockIngest = vi.fn<MemoryService['ingest']>();
  const mockQuickIngest = vi.fn<MemoryService['quickIngest']>();
  const mockStoreVerbatim = vi.fn<MemoryService['storeVerbatim']>();
  const mockWorkspaceIngest = vi.fn<MemoryService['workspaceIngest']>();
  const mockList = vi.fn<MemoryService['list']>();
  const mockScopedList = vi.fn<MemoryService['scopedList']>();
  const service = {
    scopedSearch: mockScopedSearch,
    ingest: mockIngest,
    quickIngest: mockQuickIngest,
    storeVerbatim: mockStoreVerbatim,
    workspaceIngest: mockWorkspaceIngest,
    list: mockList,
    scopedList: mockScopedList,
  } as unknown as MemoryService;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/memories', createMemoryRouter(service));
    booted = await bindEphemeral(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIngest.mockResolvedValue(EMPTY_INGEST);
    mockQuickIngest.mockResolvedValue(EMPTY_INGEST);
    mockStoreVerbatim.mockResolvedValue(EMPTY_INGEST);
    mockWorkspaceIngest.mockResolvedValue(EMPTY_INGEST);
    mockList.mockResolvedValue([]);
    mockScopedList.mockResolvedValue([]);
  });

  afterAll(async () => {
    await booted.close();
  });

  it('POST /ingest forwards a named full-ingest input', async () => {
    const response = await postJson(booted, '/memories/ingest', {
      user_id: 'u',
      conversation: 'hello',
      source_site: 'site',
      source_url: 'https://example.test/full',
      session_id: 'thread-full',
    });

    expect(response.status).toBe(200);
    expect(mockIngest).toHaveBeenCalledWith({
      userId: 'u',
      conversationText: 'hello',
      sourceSite: 'site',
      sourceUrl: 'https://example.test/full',
      effectiveConfig: undefined,
      sessionId: 'thread-full',
    });
  });

  it('POST /ingest/quick forwards a named quick-ingest input', async () => {
    const response = await postJson(booted, '/memories/ingest/quick', {
      user_id: 'u',
      conversation: 'hello',
      source_site: 'site',
      source_url: 'https://example.test/quick',
      session_id: 'thread-quick',
    });

    expect(response.status).toBe(200);
    expect(mockQuickIngest).toHaveBeenCalledWith({
      userId: 'u',
      conversationText: 'hello',
      sourceSite: 'site',
      sourceUrl: 'https://example.test/quick',
      effectiveConfig: undefined,
      sessionId: 'thread-quick',
    });
  });

  it('POST /ingest/quick skip_extraction forwards a named verbatim input', async () => {
    const metadata = { origin: 'route-test' };
    const response = await postJson(booted, '/memories/ingest/quick', {
      user_id: 'u',
      conversation: 'verbatim',
      source_site: 'site',
      source_url: 'https://example.test/verbatim',
      session_id: 'thread-verbatim',
      skip_extraction: true,
      metadata,
    });

    expect(response.status).toBe(200);
    expect(mockStoreVerbatim).toHaveBeenCalledWith({
      userId: 'u',
      content: 'verbatim',
      sourceSite: 'site',
      sourceUrl: 'https://example.test/verbatim',
      metadata,
      effectiveConfig: undefined,
      sessionId: 'thread-verbatim',
    });
  });

  it('POST /ingest with workspace forwards a named workspace input', async () => {
    const response = await postJson(booted, '/memories/ingest', {
      user_id: 'u',
      conversation: 'workspace hello',
      source_site: 'site',
      workspace_id: 'ws-1',
      agent_id: '00000000-0000-4000-8000-000000000001',
      visibility: 'workspace',
      session_id: 'thread-workspace',
    });

    expect(response.status).toBe(200);
    expect(mockWorkspaceIngest).toHaveBeenCalledWith({
      userId: 'u',
      conversationText: 'workspace hello',
      sourceSite: 'site',
      sourceUrl: '',
      workspace: {
        workspaceId: 'ws-1',
        agentId: '00000000-0000-4000-8000-000000000001',
        visibility: 'workspace',
      },
      effectiveConfig: undefined,
      sessionId: 'thread-workspace',
    });
  });

  it('GET /list forwards a named user-list input', async () => {
    const response = await fetch(
      `${booted.baseUrl}/memories/list?user_id=u&limit=7&offset=2&source_site=site&session_id=thread-list`,
    );

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({
      userId: 'u',
      limit: 7,
      offset: 2,
      sourceSite: 'site',
      episodeId: undefined,
      sessionId: 'thread-list',
    });
  });

  it('GET /list workspace forwards a named scoped-list input', async () => {
    const agentId = '00000000-0000-4000-8000-000000000002';
    const response = await fetch(
      `${booted.baseUrl}/memories/list?user_id=u&workspace_id=ws-1&agent_id=${agentId}&session_id=thread-ws-list`,
    );

    expect(response.status).toBe(200);
    expect(mockScopedList).toHaveBeenCalledWith({
      scope: { kind: 'workspace', userId: 'u', workspaceId: 'ws-1', agentId },
      limit: 20,
      offset: 0,
      sessionId: 'thread-ws-list',
    });
  });
});

function postJson(booted: BootedApp, path: string, body: unknown): Promise<Response> {
  return fetch(`${booted.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
