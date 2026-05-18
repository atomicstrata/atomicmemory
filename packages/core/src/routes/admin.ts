/**
 * @file Admin-only test-scope cleanup routes.
 *
 * These routes are intentionally absent unless the composition root mounts
 * them with a dedicated admin bearer and an explicit test-scope allow-pattern.
 * They exist for disposable smoke/eval infrastructure that needs to clean up
 * user-scoped memory data after external-core runs.
 */

import { Router, type Request, type Response } from 'express';
import { z } from '../schemas/zod-setup.js';
import { validateBody } from '../middleware/validate.js';
import { handleRouteError } from './route-errors.js';

export interface AdminMemoryRepository {
  countMemories(userId?: string): Promise<number>;
  deleteAll(userId?: string): Promise<void>;
}

export interface AdminRouterDeps {
  memory: AdminMemoryRepository;
  testScopeAllowPattern: string;
}

const DeleteScopeBodySchema = z
  .object({ user_id: z.string().trim().min(1) })
  .transform(({ user_id }) => ({ userId: user_id }));

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const allowPattern = new RegExp(deps.testScopeAllowPattern);

  router.delete('/scope', validateBody(DeleteScopeBodySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.body as { userId: string };
      if (!allowPattern.test(userId)) {
        logCleanup('rejected', userId, deps.testScopeAllowPattern, 0);
        res.status(403).json({ error: 'scope rejected by CORE_TEST_SCOPE_ALLOW_PATTERN' });
        return;
      }
      const before = await deps.memory.countMemories(userId);
      await deps.memory.deleteAll(userId);
      logCleanup('deleted', userId, deps.testScopeAllowPattern, before);
      res.json({ deleted: before });
    } catch (err) {
      handleRouteError(res, 'DELETE /v1/admin/scope', err);
    }
  });

  return router;
}

function logCleanup(status: string, userId: string, pattern: string, deleted: number): void {
  const line = JSON.stringify({
    event: 'admin.scope_cleanup',
    status,
    user_id: userId,
    allow_pattern: pattern,
    deleted,
  });
  if (status === 'rejected') {
    console.warn(line);
    return;
  }
  console.info(line);
}
