/**
 * @file MCP server configuration loader.
 *
 * Reads configuration from environment variables or an explicit object,
 * validates it, and returns a typed config that the server and the
 * embeddable `spawn` entrypoint both consume.
 */

import { hostname, userInfo } from 'node:os';
import { z } from 'zod';

const DEFAULT_CLOUD_API_URL = 'https://api.atomicstrata.ai';
const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:17350';
const CLOUD_API_HOSTNAMES = new Set([
  'api.atomicstrata.ai',
  'api.dev.atomicstrata.ai',
  'api.staging.atomicstrata.ai',
]);
const DEFAULT_LOCAL_API_KEY = 'local-dev-key';
const LOCAL_CORE_API_URL = DEFAULT_LOCAL_API_URL;
const DEFAULT_PROVIDER = 'atomicmemory';
const LOCAL_API_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

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
    scopeLock: z.boolean().default(false),
  })
  .strict();

export interface ServerConfig extends z.infer<typeof ConfigSchema> {
  apiUrl: string;
  /**
   * Hosted HTTP only: tool calls must carry an explicit scope user. The
   * container's OS identity is shared by every tenant, so inferring one
   * would pool all end users of a project into a single memory scope.
   */
  requireScopeUser?: boolean;
}
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * Load config from the process environment.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return normalizeConfig(configInputFromEnv(env), env, { requireCloudApiKey: true, inferScopeUser: true });
}

/**
 * Load hosted HTTP config without a process-wide tenant key. HTTP requests
 * authenticate independently and bind their bearer key to the MCP session.
 */
export function loadHostedHttpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const input = configInputFromEnv(env);
  if (!input.apiUrl) {
    throw new Error('ATOMICMEMORY_API_URL is required for hosted HTTP');
  }
  const config = normalizeConfig(input, env, { requireCloudApiKey: false, inferScopeUser: false });
  return { ...config, apiKey: undefined, requireScopeUser: true };
}

function configInputFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    apiUrl: cleanOptional(env.ATOMICMEMORY_API_URL),
    apiKey: cleanOptional(env.ATOMICMEMORY_API_KEY),
    provider: cleanOptional(env.ATOMICMEMORY_PROVIDER),
    scope: parseScope(env),
    scopeLock: parseScopeLock(env),
  };
}

/**
 * Parse the opt-in scope-lock flag. Returns undefined when unset so the
 * schema default (false) applies; `true`/`1` enable it. Any other value
 * is treated as disabled.
 */
function parseScopeLock(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = cleanOptional(env.ATOMICMEMORY_SCOPE_LOCK);
  if (raw === undefined) return undefined;
  return raw === 'true' || raw === '1';
}

/**
 * Validate an explicit config object passed from an embedding host
 * (e.g. the OpenClaw plugin runtime).
 */
export function validateConfig(input: unknown): ServerConfig {
  return normalizeConfig(input, process.env, { requireCloudApiKey: true, inferScopeUser: true });
}

function parseScope(env: NodeJS.ProcessEnv): Scope | undefined {
  return {
    user: cleanOptional(env.ATOMICMEMORY_SCOPE_USER),
    agent: cleanOptional(env.ATOMICMEMORY_SCOPE_AGENT),
    namespace: cleanOptional(env.ATOMICMEMORY_SCOPE_NAMESPACE),
    thread: cleanOptional(env.ATOMICMEMORY_SCOPE_THREAD),
  };
}

interface NormalizeOptions {
  requireCloudApiKey: boolean;
  /**
   * Fall back to the OS/env identity when no scope user is configured.
   * Stdio and embedded hosts run as the end user; hosted HTTP does not.
   */
  inferScopeUser: boolean;
}

function normalizeConfig(
  input: unknown,
  env: NodeJS.ProcessEnv,
  options: NormalizeOptions,
): ServerConfig {
  const parsed = ConfigSchema.parse(input);
  const apiUrl = resolveApiUrl(parsed.apiUrl, parsed.apiKey, parsed.provider);
  return {
    ...parsed,
    apiUrl,
    apiKey: resolveApiKey(parsed.apiKey, apiUrl, parsed.provider, options.requireCloudApiKey),
    scope: normalizeScope(parsed.scope, env, options.inferScopeUser),
  };
}

function normalizeScope(
  scope: Scope | undefined,
  env: NodeJS.ProcessEnv,
  inferScopeUser: boolean,
): Scope {
  const normalized: Scope = {};
  const user = cleanOptional(scope?.user) ?? (inferScopeUser ? defaultScopeUser(env) : undefined);
  if (user) normalized.user = user;
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

/**
 * Resolve the provider base URL.
 *
 * 1. Explicit `ATOMICMEMORY_API_URL` / `apiUrl` wins.
 * 2. Else, if an API key is present, default to AtomicMemory Cloud.
 * 3. Else, fall back to local Core on loopback.
 *
 * Hosted HTTP still requires an explicit URL via `loadHostedHttpConfigFromEnv`.
 */
function resolveApiUrl(
  apiUrl: string | undefined,
  apiKey: string | undefined,
  provider: ServerConfig['provider'],
): string {
  const normalized = cleanOptional(apiUrl);
  if (normalized) return normalized.replace(/\/+$/, '');
  if (provider !== 'atomicmemory') {
    throw new Error('provider=mem0 requires an explicit apiUrl');
  }
  if (cleanOptional(apiKey)) return DEFAULT_CLOUD_API_URL;
  return DEFAULT_LOCAL_API_URL;
}

function resolveApiKey(
  apiKey: string | undefined,
  apiUrl: string,
  provider: ServerConfig['provider'],
  requireCloudApiKey: boolean,
): string | undefined {
  const normalized = cleanOptional(apiKey);
  if (isInsecureCloudApiUrl(apiUrl)) {
    throw new Error(
      'ATOMICMEMORY_API_URL must use https for AtomicMemory Cloud so the project API key is never sent in cleartext',
    );
  }
  if (normalized === DEFAULT_LOCAL_API_KEY && isCloudApiUrl(apiUrl)) {
    throw new Error(
      `ATOMICMEMORY_API_KEY=${DEFAULT_LOCAL_API_KEY} is the local Core development key and is not valid for AtomicMemory Cloud; ` +
        `use a Cloud project API key, or set ATOMICMEMORY_API_URL=${LOCAL_CORE_API_URL} to use local Core`,
    );
  }
  if (normalized) return normalized;
  if (provider === 'atomicmemory' && isDefaultLocalUrl(apiUrl)) return DEFAULT_LOCAL_API_KEY;
  if (requireCloudApiKey && provider === 'atomicmemory' && isCloudApiUrl(apiUrl)) {
    throw new Error(
      'ATOMICMEMORY_API_KEY is required for AtomicMemory Cloud; ' +
        `to use local Core instead, set ATOMICMEMORY_API_URL=${LOCAL_CORE_API_URL}`,
    );
  }
  return undefined;
}

function isDefaultLocalUrl(apiUrl: string): boolean {
  const url = new URL(apiUrl);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return url.protocol === 'http:' && LOCAL_API_HOSTNAMES.has(hostname) && url.port === '17350';
}

function isCloudApiUrl(apiUrl: string): boolean {
  const url = new URL(apiUrl);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return url.protocol === 'https:' && CLOUD_API_HOSTNAMES.has(hostname) && !url.port;
}

/** A Cloud hostname reached over anything but https (e.g. `http://api.atomicstrata.ai`). */
function isInsecureCloudApiUrl(apiUrl: string): boolean {
  const url = new URL(apiUrl);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return CLOUD_API_HOSTNAMES.has(hostname) && url.protocol !== 'https:';
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
