/**
 * Agent trust and conflict resolution API routes.
 * Provides endpoints for managing agent trust levels and resolving
 * cross-agent memory conflicts.
 *
 * Request validation is delegated to the Zod schemas in
 * `src/schemas/agents.ts` via the `validateBody` / `validateQuery` /
 * `validateParams` middleware. Error messages are preserved byte-for-
 * byte from the pre-refactor inline validators.
 */

import { Router, type Request, type Response } from 'express';
import { AgentTrustRepository } from '../db/agent-trust-repository.js';
import { handleRouteError } from './route-errors.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validate.js';
import { validateResponse } from '../middleware/validate-response.js';
import { AGENT_RESPONSE_SCHEMAS } from './response-schema-map.js';
import {
  SetTrustBodySchema,
  GetTrustQuerySchema,
  UserIdFromQuerySchema,
  UserIdFromBodySchema,
  ConflictIdParamSchema,
  ResolveConflictBodySchema,
} from '../schemas/agents.js';

export function createAgentRouter(trustRepo: AgentTrustRepository): Router {
  const router = Router();
  // Dev/test-mode response validator: no-op in production, throws loudly
  // if any 2xx body violates the schema declared in responses.ts.
  router.use(validateResponse(AGENT_RESPONSE_SCHEMAS));
  registerSetTrustRoute(router, trustRepo);
  registerGetTrustRoute(router, trustRepo);
  registerListConflictsRoute(router, trustRepo);
  registerResolveConflictRoute(router, trustRepo);
  registerAutoResolveRoute(router, trustRepo);
  return router;
}

function registerSetTrustRoute(router: Router, trustRepo: AgentTrustRepository): void {
  router.put('/trust', validateBody(SetTrustBodySchema), async (req: Request, res: Response) => {
    try {
      const { agentId, userId, trustLevel, displayName } = req.body as {
        agentId: string;
        userId: string;
        trustLevel: number;
        displayName: string | undefined;
      };
      await trustRepo.setTrustLevel(agentId, userId, trustLevel, displayName);
      res.json({ agent_id: agentId, trust_level: trustLevel });
    } catch (err) {
      handleRouteError(res, 'PUT /v1/agents/trust', err);
    }
  });
}

function registerGetTrustRoute(router: Router, trustRepo: AgentTrustRepository): void {
  router.get('/trust', validateQuery(GetTrustQuerySchema), async (req: Request, res: Response) => {
    try {
      const { agentId, userId } = req.query as unknown as {
        agentId: string;
        userId: string;
      };
      const trustLevel = await trustRepo.getTrustLevel(agentId, userId);
      res.json({ agent_id: agentId, trust_level: trustLevel });
    } catch (err) {
      handleRouteError(res, 'GET /v1/agents/trust', err);
    }
  });
}

function registerListConflictsRoute(router: Router, trustRepo: AgentTrustRepository): void {
  router.get('/conflicts', validateQuery(UserIdFromQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as unknown as { userId: string };
      const conflicts = await trustRepo.listOpenConflicts(userId);
      res.json({ conflicts, count: conflicts.length });
    } catch (err) {
      handleRouteError(res, 'GET /v1/agents/conflicts', err);
    }
  });
}

function registerResolveConflictRoute(router: Router, trustRepo: AgentTrustRepository): void {
  router.put(
    '/conflicts/:id/resolve',
    validateParams(ConflictIdParamSchema),
    validateBody(ResolveConflictBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { id: conflictId } = req.params as unknown as { id: string };
        const { resolution } = req.body as {
          resolution: 'resolved_new' | 'resolved_existing' | 'resolved_both';
        };
        await trustRepo.resolveConflict(conflictId, resolution);
        res.json({ id: conflictId, status: resolution });
      } catch (err) {
        handleRouteError(res, 'PUT /v1/agents/conflicts/:id/resolve', err);
      }
    },
  );
}

function registerAutoResolveRoute(router: Router, trustRepo: AgentTrustRepository): void {
  router.post(
    '/conflicts/auto-resolve',
    validateBody(UserIdFromBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { userId } = req.body as { userId: string };
        const resolved = await trustRepo.autoResolveExpiredConflicts(userId);
        res.json({ resolved });
      } catch (err) {
        handleRouteError(res, 'POST /v1/agents/conflicts/auto-resolve', err);
      }
    },
  );
}
