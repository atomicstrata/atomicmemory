/**
 * @file Route tests for admin-only smoke-scope cleanup.
 *
 * The router is mounted on a tiny Express app with `requireBearer` so the
 * test covers the real authorization middleware, request validation, the
 * allow-pattern guard, and the repository calls without touching Postgres.
 */

import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireBearer } from '../../middleware/require-bearer.js';
import { createAdminRouter, type AdminMemoryRepository } from '../admin.js';
import { closeEphemeralServer, startEphemeralServer } from './ephemeral-server.js';

const ADMIN_KEY = 'admin-test-key';

interface MountedAdmin {
  baseUrl: string;
  repo: AdminMemoryRepository;
  server: Server;
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountAdmin(repo?: AdminMemoryRepository): Promise<MountedAdmin> {
  const app = express();
  const memory = repo ?? {
    countMemories: vi.fn(async () => 2),
    deleteAll: vi.fn(async () => undefined),
  };
  app.use(express.json());
  app.use(
    '/v1/admin',
    requireBearer(ADMIN_KEY),
    createAdminRouter({
      memory,
      testScopeAllowPattern: '^(smoke-|docker-|test-).+',
    }),
  );
  const { baseUrl, server } = await startEphemeralServer(app);
  return { baseUrl, repo: memory, server };
}

const closeServer = closeEphemeralServer;

function adminHeaders(key = ADMIN_KEY): Record<string, string> {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

async function deleteScope(baseUrl: string, userId?: string, key = ADMIN_KEY): Promise<Response> {
  const body = userId === undefined ? {} : { user_id: userId };
  return fetch(`${baseUrl}/v1/admin/scope`, {
    method: 'DELETE',
    headers: adminHeaders(key),
    body: JSON.stringify(body),
  });
}

describe('DELETE /v1/admin/scope', () => {
  it('requires the dedicated admin bearer', async () => {
    const mounted = await mountAdmin();
    try {
      const res = await deleteScope(mounted.baseUrl, 'smoke-123', 'wrong-key');
      expect(res.status).toBe(401);
      expect(mounted.repo.deleteAll).not.toHaveBeenCalled();
    } finally {
      await closeServer(mounted.server);
    }
  });

  it('rejects user ids outside the configured test-scope pattern', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mounted = await mountAdmin();
    try {
      const res = await deleteScope(mounted.baseUrl, 'real-user');
      const body = (await res.json()) as { error: string };
      expect(res.status).toBe(403);
      expect(body.error).toMatch(/CORE_TEST_SCOPE_ALLOW_PATTERN/);
      expect(mounted.repo.deleteAll).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"status":"rejected"'));
    } finally {
      await closeServer(mounted.server);
    }
  });

  it('deletes only the requested allowed scope and reports count', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const mounted = await mountAdmin();
    try {
      const res = await deleteScope(mounted.baseUrl, 'smoke-123');
      const body = (await res.json()) as { deleted: number };
      expect(res.status).toBe(200);
      expect(body.deleted).toBe(2);
      expect(mounted.repo.countMemories).toHaveBeenCalledWith('smoke-123');
      expect(mounted.repo.deleteAll).toHaveBeenCalledWith('smoke-123');
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"status":"deleted"'));
    } finally {
      await closeServer(mounted.server);
    }
  });

  it('returns validation errors for missing user_id', async () => {
    const mounted = await mountAdmin();
    try {
      const res = await deleteScope(mounted.baseUrl);
      expect(res.status).toBe(400);
      expect(mounted.repo.deleteAll).not.toHaveBeenCalled();
    } finally {
      await closeServer(mounted.server);
    }
  });
});
