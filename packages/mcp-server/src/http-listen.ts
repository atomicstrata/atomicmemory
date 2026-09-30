/**
 * @file HTTP listen / transport selection for hosted MCP mode.
 *
 * Stdio remains the default CLI transport. HTTP mode is selected via
 * `--http` or `ATOMICMEMORY_MCP_TRANSPORT=http`.
 */

import { z } from 'zod';
import { DEFAULT_AUTH_CACHE_TTL_MS, DEFAULT_AUTH_TIMEOUT_MS } from './auth.js';

/** Default listen port for hosted MCP HTTP. */
export const DEFAULT_MCP_HTTP_PORT = 3100;

/** Default bind address for containerized hosted deployments. */
export const DEFAULT_MCP_HTTP_HOST = '0.0.0.0';

/** Idle MCP sessions are closed after this long without a request. */
export const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

/** Process-wide cap on concurrently open MCP sessions. */
export const DEFAULT_MAX_SESSIONS = 1_000;

/** Cap on concurrently open MCP sessions per project API key. */
export const DEFAULT_MAX_SESSIONS_PER_KEY = 50;

export type McpTransport = 'stdio' | 'http';

export interface HttpListenConfig {
  host: string;
  port: number;
  /** Serve deprecated SSE (`GET /sse` + `POST /messages`) for legacy SSE clients. */
  enableSse: boolean;
  /**
   * Host header allowlist for DNS-rebinding protection on the MCP routes.
   * Unset keeps the SDK default (validation only on loopback binds).
   */
  allowedHosts?: string[] | undefined;
}

/** Resource limits for hosted HTTP sessions and key validation. */
export interface HostedHttpLimits {
  sessionIdleTtlMs: number;
  maxSessions: number;
  maxSessionsPerKey: number;
  authTimeoutMs: number;
  /** 0 disables the positive key-validation cache. */
  authCacheTtlMs: number;
}

export const DEFAULT_HOSTED_HTTP_LIMITS: HostedHttpLimits = {
  sessionIdleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS,
  maxSessions: DEFAULT_MAX_SESSIONS,
  maxSessionsPerKey: DEFAULT_MAX_SESSIONS_PER_KEY,
  authTimeoutMs: DEFAULT_AUTH_TIMEOUT_MS,
  authCacheTtlMs: DEFAULT_AUTH_CACHE_TTL_MS,
};

const HttpListenSchema = z
  .object({
    host: z.string().min(1).default(DEFAULT_MCP_HTTP_HOST),
    port: z.number().int().min(1).max(65535).default(DEFAULT_MCP_HTTP_PORT),
    enableSse: z.boolean().default(true),
    allowedHosts: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/**
 * Resolve CLI transport from argv + env. Default is stdio so existing
 * `atomicmemory-mcp` / plugin spawns keep using the local transport.
 */
export function resolveTransport(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): McpTransport {
  if (argv.includes('--http')) return 'http';
  if (argv.includes('--stdio')) return 'stdio';

  const raw = cleanOptional(env.ATOMICMEMORY_MCP_TRANSPORT)?.toLowerCase();
  if (raw === 'http') return 'http';
  if (raw === 'stdio' || raw === undefined) return 'stdio';
  throw new Error(
    `ATOMICMEMORY_MCP_TRANSPORT must be "stdio" or "http" (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Load HTTP listen settings from the environment.
 */
export function loadHttpListenConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpListenConfig {
  const portRaw = cleanOptional(env.ATOMICMEMORY_MCP_PORT);
  const port = portRaw === undefined ? DEFAULT_MCP_HTTP_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `ATOMICMEMORY_MCP_PORT must be an integer 1–65535 (got ${JSON.stringify(portRaw)})`,
    );
  }

  const enableSseRaw = cleanOptional(env.ATOMICMEMORY_MCP_ENABLE_SSE);
  const enableSse =
    enableSseRaw === undefined
      ? true
      : enableSseRaw === 'true' || enableSseRaw === '1';

  const allowedHosts = parseAllowedHosts(env.ATOMICMEMORY_MCP_ALLOWED_HOSTS);

  return HttpListenSchema.parse({
    host: cleanOptional(env.ATOMICMEMORY_MCP_HOST) ?? DEFAULT_MCP_HTTP_HOST,
    port,
    enableSse,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
}

/**
 * Parse `ATOMICMEMORY_MCP_ALLOWED_HOSTS`: comma-separated hostnames without
 * ports (IPv6 in brackets). Unset or blank returns undefined.
 */
function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  const hosts = (raw ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Load hosted session and key-validation limits from the environment.
 * Unset values use the defaults; malformed values fail startup.
 */
export function loadHostedHttpLimits(
  env: NodeJS.ProcessEnv = process.env,
): HostedHttpLimits {
  const d = DEFAULT_HOSTED_HTTP_LIMITS;
  return {
    sessionIdleTtlMs: readInteger(env, 'ATOMICMEMORY_MCP_SESSION_IDLE_TTL_MS', d.sessionIdleTtlMs, 1),
    maxSessions: readInteger(env, 'ATOMICMEMORY_MCP_MAX_SESSIONS', d.maxSessions, 1),
    maxSessionsPerKey: readInteger(env, 'ATOMICMEMORY_MCP_MAX_SESSIONS_PER_KEY', d.maxSessionsPerKey, 1),
    authTimeoutMs: readInteger(env, 'ATOMICMEMORY_MCP_AUTH_TIMEOUT_MS', d.authTimeoutMs, 1),
    authCacheTtlMs: readInteger(env, 'ATOMICMEMORY_MCP_AUTH_CACHE_TTL_MS', d.authCacheTtlMs, 0),
  };
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = cleanOptional(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}
