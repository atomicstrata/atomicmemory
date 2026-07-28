/**
 * Dual authentication for SDK-facing `/v1/*` routes.
 *
 * Accepts either the deployment-wide `CORE_API_KEY` (when explicitly enabled
 * as a fallback) or a Cloud-issued RS256 JWT verified against a remote JWKS.
 * On JWT success the verified `memory_user_id` / `project_id` claims are
 * injected as asserted-user headers so downstream scope enforcement sees a
 * stable end-user identity.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { CloudJwtConfig } from '../config.js';
import { ASSERTED_USER_HEADER } from './asserted-user.js';
import { enforceMemoryUserBinding } from './cloud-jwt-user-binding.js';
import { readBearerToken, requireBearer, respondUnauthenticated } from './require-bearer.js';
const JWKS_PREFETCH_TIMEOUT_MS = 5_000;

export interface DualAuthOptions {
  coreApiKey: string;
  cloudJwt: CloudJwtConfig | null;
}

export interface AuthMiddlewareBundle {
  middleware: RequestHandler;
  prefetchJwks?: () => Promise<boolean>;
  isJwksReady?: () => boolean;
}

export interface CloudJwtVerifier {
  config: CloudJwtConfig;
  jwks: JWTVerifyGetKey;
  prefetch: () => Promise<boolean>;
  isReady: () => boolean;
  markReady: () => void;
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function respondForbidden(res: Response, reason: string): void {
  res.status(403).json({ error_code: 'forbidden', error: reason });
}

function injectAssertedIdentity(req: Request, memoryUserId: string): void {
  req.headers[ASSERTED_USER_HEADER.toLowerCase()] = memoryUserId;
}

/**
 * True when a project binding is configured and the token's `project_id`
 * claim does not match it. A null binding means single-tenant local mode:
 * Core trusts whatever project the Cloud-minted token carries.
 */
function tokenProjectMismatch(boundProjectId: string | null, tokenProjectId: string): boolean {
  return boundProjectId !== null && tokenProjectId !== boundProjectId;
}

function readRequiredStringClaim(payload: Record<string, unknown>, claim: string): string | null {
  const value = payload[claim];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Create a shared JWKS verifier for Cloud JWT auth. The remote JWK set is
 * constructed once and reused across requests.
 */
function createCloudJwtVerifier(cloudJwt: CloudJwtConfig): CloudJwtVerifier {
  const jwks = createRemoteJWKSet(new URL(cloudJwt.jwksUrl));
  let jwksReady = false;

  return {
    config: cloudJwt,
    jwks,
    isReady: () => jwksReady,
    markReady: () => {
      jwksReady = true;
    },
    async prefetch(): Promise<boolean> {
      try {
        const response = await fetch(cloudJwt.jwksUrl, {
          signal: AbortSignal.timeout(JWKS_PREFETCH_TIMEOUT_MS),
        });
        if (response.ok) {
          jwksReady = true;
        }
      } catch {
        // Degraded until a verify path loads keys into the jose cache.
      }
      return jwksReady;
    },
  };
}

/**
 * Build auth middleware: static bearer and/or Cloud JWT (when configured).
 */
export function createAuthMiddleware(options: DualAuthOptions): AuthMiddlewareBundle {
  const staticBearer = requireBearer(options.coreApiKey);
  if (!options.cloudJwt) {
    return { middleware: staticBearer };
  }

  const verifier = createCloudJwtVerifier(options.cloudJwt);

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);
    if (token === null) {
      respondUnauthenticated(res, 'missing or malformed Authorization header');
      return;
    }

    if (!looksLikeJwt(token)) {
      if (options.cloudJwt!.staticKeyFallbackEnabled) {
        staticBearer(req, res, next);
        return;
      }
      respondUnauthenticated(res, 'invalid api key');
      return;
    }

    void (async () => {
      try {
        const { payload } = await jwtVerify(token, verifier.jwks, {
          algorithms: ['RS256'],
          issuer: options.cloudJwt!.issuer,
          audience: options.cloudJwt!.audience,
        });
        verifier.markReady();

        const principalId = typeof payload.sub === 'string' ? payload.sub : null;
        let memoryUserId = readRequiredStringClaim(payload as Record<string, unknown>, 'memory_user_id');
        if (!memoryUserId) {
          memoryUserId = options.cloudJwt!.legacyDefaultMemoryUserId;
        }
        const projectId = readRequiredStringClaim(payload as Record<string, unknown>, 'project_id');

        if (!principalId || !memoryUserId || !projectId) {
          respondUnauthenticated(res, 'invalid api key');
          return;
        }

        if (tokenProjectMismatch(options.cloudJwt!.projectId, projectId)) {
          respondForbidden(res, 'token project_id does not match configured Cloud project');
          return;
        }

        if (!enforceMemoryUserBinding(req, memoryUserId, res)) {
          return;
        }

        injectAssertedIdentity(req, memoryUserId);
        next();
      } catch {
        respondUnauthenticated(res, 'invalid api key');
      }
    })();
  };

  return {
    middleware,
    prefetchJwks: () => verifier.prefetch(),
    isJwksReady: () => verifier.isReady(),
  };
}
