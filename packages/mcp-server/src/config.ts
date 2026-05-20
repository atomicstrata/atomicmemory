/**
 * @file MCP server configuration loader.
 *
 * Reads configuration from environment variables or an explicit object,
 * validates it, and returns a typed config that the server and the
 * embeddable `spawn` entrypoint both consume.
 */

import { hostname, userInfo } from 'node:os';
import { z } from 'zod';

const DEFAULT_API_URL = 'http://127.0.0.1:17350';
const DEFAULT_LOCAL_API_KEY = 'local-dev-key';
const DEFAULT_PROVIDER = 'atomicmemory';

const ScopeSchema = z
  .object({
    user: z.string().optional(),
    agent: z.string().optional(),
    namespace: z.string().optional(),
    thread: z.string().optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    apiUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    provider: z.enum(['atomicmemory', 'mem0']).default(DEFAULT_PROVIDER),
    scope: ScopeSchema.optional(),
  })
  .strict();

export interface ServerConfig extends z.infer<typeof ConfigSchema> {
  apiUrl: string;
}
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * Load config from the process environment.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = {
    apiUrl: cleanOptional(env.ATOMICMEMORY_API_URL),
    apiKey: cleanOptional(env.ATOMICMEMORY_API_KEY),
    provider: cleanOptional(env.ATOMICMEMORY_PROVIDER),
    scope: parseScope(env),
  };
  return normalizeConfig(raw, env);
}

/**
 * Validate an explicit config object passed from an embedding host
 * (e.g. the OpenClaw plugin runtime).
 */
export function validateConfig(input: unknown): ServerConfig {
  return normalizeConfig(input, process.env);
}

function parseScope(env: NodeJS.ProcessEnv): Scope | undefined {
  return {
    user: cleanOptional(env.ATOMICMEMORY_SCOPE_USER),
    agent: cleanOptional(env.ATOMICMEMORY_SCOPE_AGENT),
    namespace: cleanOptional(env.ATOMICMEMORY_SCOPE_NAMESPACE),
    thread: cleanOptional(env.ATOMICMEMORY_SCOPE_THREAD),
  };
}

function normalizeConfig(input: unknown, env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = ConfigSchema.parse(input);
  const apiUrl = resolveApiUrl(parsed.apiUrl, parsed.provider);
  return {
    ...parsed,
    apiUrl,
    apiKey: resolveApiKey(parsed.apiKey, apiUrl, parsed.provider),
    scope: normalizeScope(parsed.scope, env),
  };
}

function normalizeScope(scope: Scope | undefined, env: NodeJS.ProcessEnv): Scope {
  const normalized: Scope = {
    user: cleanOptional(scope?.user) ?? defaultScopeUser(env),
  };
  const agent = cleanOptional(scope?.agent);
  const namespace = cleanOptional(scope?.namespace);
  const thread = cleanOptional(scope?.thread);

  if (agent) normalized.agent = agent;
  if (namespace) normalized.namespace = namespace;
  if (thread) normalized.thread = thread;

  return ScopeSchema.parse(normalized);
}

function defaultScopeUser(env: NodeJS.ProcessEnv): string {
  return (
    cleanOptional(env.USER) ??
    cleanOptional(env.USERNAME) ??
    readOsUsername() ??
    cleanOptional(hostname()) ??
    'local-machine'
  );
}

function resolveApiUrl(
  apiUrl: string | undefined,
  provider: ServerConfig['provider'],
): string {
  const normalized = cleanOptional(apiUrl);
  if (normalized) return normalized.replace(/\/+$/, '');
  if (provider === 'atomicmemory') return DEFAULT_API_URL;
  throw new Error('provider=mem0 requires an explicit apiUrl');
}

function resolveApiKey(
  apiKey: string | undefined,
  apiUrl: string,
  provider: ServerConfig['provider'],
): string | undefined {
  const normalized = cleanOptional(apiKey);
  if (normalized) return normalized;
  if (provider === 'atomicmemory' && isDefaultLocalUrl(apiUrl)) return DEFAULT_LOCAL_API_KEY;
  return undefined;
}

function isDefaultLocalUrl(apiUrl: string): boolean {
  return apiUrl === DEFAULT_API_URL;
}

function readOsUsername(): string | undefined {
  try {
    return cleanOptional(userInfo().username);
  } catch {
    return undefined;
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}
