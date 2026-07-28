/**
 * Parse Cloud JWT verification env (inbound console/SDK tokens).
 */

import type { CloudJwtConfig } from './types.js';
import { optionalEnv, parseStrictBoolEnv } from './env.js';

function requireCloudJwtFields(
  jwksUrl: string | undefined,
  issuer: string | undefined,
  audience: string | undefined,
): asserts jwksUrl is string {
  if (jwksUrl && issuer && audience) return;
  throw new Error(
    'CLOUD_JWKS_URL, CLOUD_JWT_ISSUER, and CLOUD_JWT_AUDIENCE must all be set together when enabling Cloud JWT verification',
  );
}

function buildCloudJwtConfig(
  jwksUrl: string,
  issuer: string,
  audience: string,
  projectId: string | undefined,
  staticKeyFallbackRaw: string | undefined,
): CloudJwtConfig {
  const staticKeyFallbackEnabled =
    staticKeyFallbackRaw === undefined
      ? false
      : parseStrictBoolEnv('CLOUD_JWT_STATIC_KEY_FALLBACK', false);
  const legacyDefaultMemoryUserId =
    optionalEnv('CLOUD_JWT_LEGACY_DEFAULT_MEMORY_USER_ID')?.trim() || null;
  return {
    jwksUrl,
    issuer,
    audience,
    projectId: projectId?.trim() || null,
    staticKeyFallbackEnabled,
    legacyDefaultMemoryUserId,
  };
}

export function parseCloudJwtConfig(): CloudJwtConfig | null {
  const jwksUrl = optionalEnv('CLOUD_JWKS_URL');
  const issuer = optionalEnv('CLOUD_JWT_ISSUER');
  const audience = optionalEnv('CLOUD_JWT_AUDIENCE');
  const projectId = optionalEnv('CLOUD_PROJECT_ID');
  const staticKeyFallbackRaw = optionalEnv('CLOUD_JWT_STATIC_KEY_FALLBACK');
  if (
    jwksUrl === undefined &&
    issuer === undefined &&
    audience === undefined &&
    projectId === undefined &&
    staticKeyFallbackRaw === undefined
  ) {
    return null;
  }

  requireCloudJwtFields(jwksUrl, issuer, audience);
  try {
    void new URL(jwksUrl);
  } catch {
    throw new Error(`CLOUD_JWKS_URL must be a valid URL, got '${jwksUrl}'`);
  }

  return buildCloudJwtConfig(jwksUrl, issuer!, audience!, projectId, staticKeyFallbackRaw);
}
