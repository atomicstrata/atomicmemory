/**
 * @file Resolve AtomicMemory HTTP configuration without leaking server keys
 * to browser contexts or explicitly configured non-Cloud endpoints.
 */

import { validateApiUrl } from '../../utils/validate-api-url';
import type { HttpOptions } from '../shared/http-client';
import {
  ATOMICMEMORY_DEFAULT_TIMEOUT,
  type AtomicMemoryProviderConfig,
} from './types';

const ATOMICMEMORY_DEFAULT_API_URL = 'https://api.atomicstrata.ai';
const LOCAL_CORE_DEVELOPMENT_API_KEY = 'local-dev-key';
const CLOUD_API_HOSTNAMES = new Set([
  'api.atomicstrata.ai',
  'api.dev.atomicstrata.ai',
  'api.staging.atomicstrata.ai',
]);

/** Resolve defaults and require credentials before any Cloud request is made. */
export function resolveAtomicMemoryHttpConfig(
  config: AtomicMemoryProviderConfig,
): HttpOptions {
  const apiUrl = validateApiUrl(config.apiUrl ?? ATOMICMEMORY_DEFAULT_API_URL, {
    allowPrivateNetworks: config.allowPrivateNetworks,
  }).replace(/\/+$/, '');
  const url = new URL(apiUrl);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const isCloudHost = CLOUD_API_HOSTNAMES.has(hostname);
  if (isCloudHost && url.protocol !== 'https:') {
    throw new Error('AtomicMemory Cloud requires HTTPS so API keys are not sent in cleartext.');
  }
  const isCloud = isCloudHost && !url.port;
  const allowEnvironmentKey = isCloud && !url.username && !url.password;
  const apiKey = config.apiKey ?? (allowEnvironmentKey ? readServerApiKey() : undefined);
  if (isCloud && !apiKey?.trim()) {
    throw new Error(
      'AtomicMemory Cloud requires an API key. Set ATOMICMEMORY_API_KEY in ' +
      'your Node/server environment or pass providers.atomicmemory.apiKey. ' +
      'Browser callers must pass apiKey explicitly.',
    );
  }
  if (isCloud && apiKey?.trim() === LOCAL_CORE_DEVELOPMENT_API_KEY) {
    throw new Error(
      'The local Core development key is not valid for AtomicMemory Cloud. ' +
      'Use a Cloud project API key or set providers.atomicmemory.apiUrl to your local Core endpoint.',
    );
  }
  return { apiUrl, apiKey, timeout: config.timeout ?? ATOMICMEMORY_DEFAULT_TIMEOUT };
}

function readServerApiKey(): string | undefined {
  if (typeof window !== 'undefined' || typeof self !== 'undefined') return undefined;
  const runtime = globalThis.process;
  if (!runtime?.versions?.node) return undefined;
  // Read at runtime through the environment object, not a bundler-replaced
  // process.env.KEY expression that could embed a server secret in client JS.
  const environment = runtime.env;
  return environment?.['ATOMICMEMORY_API_KEY'];
}
