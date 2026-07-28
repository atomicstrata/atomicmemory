/**
 * Parse Cloud trace sync env (outbound amc_ uploads).
 */

import type { CloudTraceSyncConfig } from './types.js';
import { optionalEnv, parsePositiveIntEnv } from './env.js';

function requireCloudTraceSyncCredentials(
  apiUrl: string | undefined,
  apiKey: string | undefined,
): asserts apiUrl is string {
  if (apiUrl && apiKey) return;
  throw new Error(
    'Cloud trace sync requires ATOMICMEMORY_API_URL and ATOMICMEMORY_API_KEY when CLOUD_TRACE_SYNC_ENABLED=true',
  );
}

function buildCloudTraceSyncConfig(
  apiUrl: string,
  apiKey: string,
  instanceId: string | undefined,
): CloudTraceSyncConfig {
  if (!apiKey.startsWith('amc_')) {
    throw new Error('ATOMICMEMORY_API_KEY must be a project-scoped amc_ Cloud API key');
  }

  return {
    enabled: true,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiKey,
    instanceId: instanceId?.trim() || '',
    batchSize: parsePositiveIntEnv('CLOUD_TRACE_SYNC_BATCH_SIZE', 100),
    maxAttempts: parsePositiveIntEnv('CLOUD_TRACE_SYNC_MAX_ATTEMPTS', 8),
    baseRetryMs: parsePositiveIntEnv('CLOUD_TRACE_SYNC_BASE_RETRY_MS', 1_000),
    maxRetryMs: parsePositiveIntEnv('CLOUD_TRACE_SYNC_MAX_RETRY_MS', 300_000),
    pollIntervalMs: parsePositiveIntEnv('CLOUD_TRACE_SYNC_POLL_INTERVAL_MS', 5_000),
    sentRetentionMs: parsePositiveIntEnv('CLOUD_TRACE_SYNC_SENT_RETENTION_MS', 86_400_000),
    shutdownDrainMs: parsePositiveIntEnv('CLOUD_TRACE_SYNC_SHUTDOWN_DRAIN_MS', 10_000),
    claimStaleMs: parsePositiveIntEnv('CLOUD_TRACE_SYNC_CLAIM_STALE_MS', 300_000),
    deadLetterRetentionMs: parsePositiveIntEnv('CLOUD_TRACE_SYNC_DEAD_LETTER_RETENTION_MS', 604_800_000),
    maxPending: parsePositiveIntEnv('CLOUD_TRACE_SYNC_MAX_PENDING', 10_000),
  };
}

export function parseCloudTraceSyncConfig(): CloudTraceSyncConfig | null {
  const enabledRaw = optionalEnv('CLOUD_TRACE_SYNC_ENABLED');
  const apiUrl = optionalEnv('ATOMICMEMORY_API_URL');
  const apiKey = optionalEnv('ATOMICMEMORY_API_KEY');
  const instanceId = optionalEnv('CORE_INSTANCE_ID');
  const partial = Boolean(enabledRaw || apiUrl || apiKey || instanceId);

  if (!partial) return null;
  if (enabledRaw === 'false') return null;

  const enabled = enabledRaw === 'true';
  if (!enabled) {
    throw new Error(
      'Partial Cloud trace sync configuration detected. Set CLOUD_TRACE_SYNC_ENABLED=true with ATOMICMEMORY_API_URL and ATOMICMEMORY_API_KEY, or remove all Cloud trace sync env vars.',
    );
  }

  requireCloudTraceSyncCredentials(apiUrl, apiKey);
  return buildCloudTraceSyncConfig(apiUrl, apiKey!, instanceId);
}
