/**
 * OSS Core → Cloud trace sync runtime: enqueue hooks, background uploader, health.
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { cloudApiPost } from '../cloud/cloud-api-client.js';
import { resolveCoreInstanceId } from '../cloud/instance-id.js';
import { sendRuntimeHeartbeat } from '../cloud/heartbeat-client.js';
import type { CloudTraceSyncConfig } from '../config.js';
import { readPackageVersion } from '../db/migration-schema.js';
import {
  claimCloudTraceBatch,
  countDeadLetterCloudTraces,
  countPendingCloudTraces,
  enqueueCloudTraceOutbox,
  getOldestPendingCloudTraceAgeMs,
  markCloudTraceDeadLetter,
  markCloudTraceSent,
  purgeDeadLetterCloudTraces,
  purgeSentCloudTraces,
  scheduleCloudTraceRetry,
} from '../db/cloud-trace-outbox-repository.js';
import {
  buildCloudTraceEnvelope,
  type CloudTraceOperation,
  type CloudTraceOutcome,
} from './cloud-trace-envelope.js';

const RUNTIME_CAPABILITIES = ['memory.read', 'memory.write', 'trace.stream'] as const;
const HEALTH_CACHE_TTL_MS = 5_000;

export interface CloudTraceHealthSnapshot {
  status: 'healthy' | 'degraded' | 'paused' | 'disabled';
  pendingCount: number;
  oldestPendingAgeMs: number | null;
  lastSuccessAt: string | null;
  deadLetterCount: number;
  lastErrorCode: string | null;
  lastHeartbeatAt: string | null;
  heartbeatStatus: 'ok' | 'failed' | 'auth_paused' | 'skipped';
  enqueueFailures: number;
}

/** Public liveness view — no backlog counts or error codes. */
export interface CloudTracePublicHealth {
  status: 'healthy' | 'degraded' | 'paused' | 'disabled';
}

export interface RecordCloudTraceOperationInput {
  operation: CloudTraceOperation;
  outcome?: CloudTraceOutcome;
  durationMs: number;
  userId?: string;
  summary?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

interface UploaderRuntime {
  pool: pg.Pool;
  config: CloudTraceSyncConfig;
  instanceId: string;
  timer: NodeJS.Timeout | null;
  draining: boolean;
  paused: boolean;
  inFlight: Promise<void>;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  enqueueFailures: number;
  lastHeartbeatAt: Date | null;
  heartbeatStatus: CloudTraceHealthSnapshot['heartbeatStatus'];
  healthCache: { expiresAt: number; snapshot: CloudTraceHealthSnapshot } | null;
}

let uploaderRuntime: UploaderRuntime | null = null;

export function recordCloudTraceOperation(
  pool: pg.Pool,
  syncConfig: CloudTraceSyncConfig | null | undefined,
  instanceId: string | null | undefined,
  input: RecordCloudTraceOperationInput,
): void {
  if (!syncConfig?.enabled || !instanceId) return;
  void enqueueCloudTraceFromInput(pool, syncConfig, instanceId, input).catch((error) => {
    if (uploaderRuntime) uploaderRuntime.enqueueFailures += 1;
    console.error('[cloud-trace-sync] enqueue failed:', error);
  });
}

async function enqueueCloudTraceFromInput(
  pool: pg.Pool,
  syncConfig: CloudTraceSyncConfig,
  instanceId: string,
  input: RecordCloudTraceOperationInput,
): Promise<void> {
  const pending = await countPendingCloudTraces(pool);
  if (pending >= syncConfig.maxPending) {
    if (uploaderRuntime) uploaderRuntime.enqueueFailures += 1;
    throw new Error(`cloud trace outbox backlog at cap (${syncConfig.maxPending})`);
  }
  const summary = {
    user_id: input.userId ?? 'default',
    ...(input.summary ?? {}),
  };
  const envelope = buildCloudTraceEnvelope({
    eventId: randomUUID(),
    coreInstanceId: instanceId,
    occurredAt: new Date().toISOString(),
    operation: input.operation,
    outcome: input.outcome ?? 'success',
    durationMs: Math.max(0, Math.round(input.durationMs)),
    summary,
    evidence: input.evidence,
  });
  await enqueueCloudTraceOutbox(pool, envelope);
}

export async function startCloudTraceSync(
  pool: pg.Pool,
  syncConfig: CloudTraceSyncConfig,
): Promise<void> {
  if (uploaderRuntime) return;
  const instanceId = await resolveCoreInstanceId(syncConfig.instanceId);
  syncConfig.instanceId = instanceId;
  uploaderRuntime = {
    pool,
    config: syncConfig,
    instanceId,
    timer: null,
    draining: false,
    paused: false,
    inFlight: Promise.resolve(),
    lastSuccessAt: null,
    lastErrorCode: null,
    enqueueFailures: 0,
    lastHeartbeatAt: null,
    heartbeatStatus: 'skipped',
    healthCache: null,
  };
  scheduleUploaderTick();
}

export async function stopCloudTraceSync(): Promise<void> {
  const runtime = uploaderRuntime;
  if (!runtime) return;
  runtime.draining = true;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
  const deadline = Date.now() + runtime.config.shutdownDrainMs;
  while (Date.now() < deadline) {
    await runtime.inFlight;
    const pending = await countPendingCloudTraces(runtime.pool);
    if (pending === 0) break;
    if (runtime.paused) break;
    const claimed = await claimCloudTraceBatch(
      runtime.pool,
      runtime.config.batchSize,
      runtime.config.claimStaleMs,
    );
    if (claimed.length === 0) break;
    for (const row of claimed) {
      await uploadRow(runtime, row.eventId, row.payload, row.attemptCount);
    }
    await sleep(Math.min(runtime.config.pollIntervalMs, deadline - Date.now()));
  }
  uploaderRuntime = null;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCloudTraceHealthSnapshot(): CloudTraceHealthSnapshot {
  const runtime = uploaderRuntime;
  if (!runtime) {
    return {
      status: 'disabled',
      pendingCount: 0,
      oldestPendingAgeMs: null,
      lastSuccessAt: null,
      deadLetterCount: 0,
      lastErrorCode: null,
      lastHeartbeatAt: null,
      heartbeatStatus: 'skipped',
      enqueueFailures: 0,
    };
  }
  return {
    status: runtime.paused ? 'paused' : runtime.lastErrorCode ? 'degraded' : 'healthy',
    pendingCount: 0,
    oldestPendingAgeMs: null,
    lastSuccessAt: runtime.lastSuccessAt?.toISOString() ?? null,
    deadLetterCount: 0,
    lastErrorCode: runtime.lastErrorCode,
    lastHeartbeatAt: runtime.lastHeartbeatAt?.toISOString() ?? null,
    heartbeatStatus: runtime.heartbeatStatus,
    enqueueFailures: runtime.enqueueFailures,
  };
}

export async function getCloudTraceHealthSnapshotAsync(
  pool: pg.Pool,
  syncConfig: CloudTraceSyncConfig | null | undefined,
): Promise<CloudTraceHealthSnapshot> {
  if (!syncConfig?.enabled) {
    return getCloudTraceHealthSnapshot();
  }
  const runtime = uploaderRuntime;
  const now = Date.now();
  if (runtime?.healthCache && runtime.healthCache.expiresAt > now) {
    return runtime.healthCache.snapshot;
  }
  const [pendingCount, oldestPendingAgeMs, deadLetterCount] = await Promise.all([
    countPendingCloudTraces(pool),
    getOldestPendingCloudTraceAgeMs(pool),
    countDeadLetterCloudTraces(pool),
  ]);
  let status: CloudTraceHealthSnapshot['status'] = 'healthy';
  if (runtime?.paused) status = 'paused';
  else if (deadLetterCount > 0 || (oldestPendingAgeMs ?? 0) > 300_000) status = 'degraded';
  const snapshot: CloudTraceHealthSnapshot = {
    status,
    pendingCount,
    oldestPendingAgeMs,
    lastSuccessAt: runtime?.lastSuccessAt?.toISOString() ?? null,
    deadLetterCount,
    lastErrorCode: runtime?.lastErrorCode ?? null,
    lastHeartbeatAt: runtime?.lastHeartbeatAt?.toISOString() ?? null,
    heartbeatStatus: runtime?.heartbeatStatus ?? 'skipped',
    enqueueFailures: runtime?.enqueueFailures ?? 0,
  };
  if (runtime) {
    runtime.healthCache = { expiresAt: now + HEALTH_CACHE_TTL_MS, snapshot };
  }
  return snapshot;
}

export function toCloudTracePublicHealth(
  snapshot: CloudTraceHealthSnapshot,
): CloudTracePublicHealth {
  return { status: snapshot.status };
}

function scheduleUploaderTick(): void {
  const runtime = uploaderRuntime;
  if (!runtime || runtime.draining) return;
  runtime.timer = setTimeout(() => {
    runtime.inFlight = uploadOnce(runtime)
      .catch((error) => {
        runtime.lastErrorCode = 'upload_loop_error';
        console.error('[cloud-trace-sync] upload tick failed:', error);
      })
      .finally(() => {
        purgeSentCloudTraces(runtime.pool, runtime.config.sentRetentionMs).catch(() => {});
        purgeDeadLetterCloudTraces(runtime.pool, runtime.config.deadLetterRetentionMs).catch(
          () => {},
        );
        scheduleUploaderTick();
      });
  }, runtime.config.pollIntervalMs);
}

async function uploadOnce(runtime: UploaderRuntime): Promise<void> {
  if (!runtime.draining) {
    await sendHeartbeatOnce(runtime);
  }
  if (runtime.paused) return;
  const batch = await claimCloudTraceBatch(
    runtime.pool,
    runtime.config.batchSize,
    runtime.config.claimStaleMs,
  );
  for (const row of batch) {
    await uploadRow(runtime, row.eventId, row.payload, row.attemptCount);
  }
}

function resolveLocalUrl(): string {
  const port = process.env.PORT ?? '17350';
  return `http://127.0.0.1:${port}`;
}

function clearAuthPause(runtime: UploaderRuntime): void {
  resetCloudTraceAuthPause(runtime);
}

/** Clear sticky auth pause after a successful heartbeat or upload. */
export function resetCloudTraceAuthPause(state: {
  paused: boolean;
  lastErrorCode: string | null;
}): void {
  state.paused = false;
  state.lastErrorCode = null;
}

async function sendHeartbeatOnce(runtime: UploaderRuntime): Promise<void> {
  const packageVersion = readPackageVersion();
  const result = await sendRuntimeHeartbeat({
    apiUrl: runtime.config.apiUrl,
    apiKey: runtime.config.apiKey,
    payload: {
      core_instance_id: runtime.instanceId,
      core_version: packageVersion,
      connector_version: packageVersion,
      capabilities: [...RUNTIME_CAPABILITIES],
      local_url: resolveLocalUrl(),
    },
  });
  if (result.ok) {
    runtime.lastHeartbeatAt = new Date();
    runtime.heartbeatStatus = 'ok';
    clearAuthPause(runtime);
    return;
  }
  runtime.heartbeatStatus = result.errorCode?.startsWith('auth_') ? 'auth_paused' : 'failed';
  if (result.errorCode?.startsWith('auth_')) {
    runtime.paused = true;
    runtime.lastErrorCode = result.errorCode;
  }
}

async function uploadRow(
  runtime: UploaderRuntime,
  eventId: string,
  payload: unknown,
  attemptCount: number,
): Promise<void> {
  let response: Response;
  try {
    response = await cloudApiPost({
      apiUrl: runtime.config.apiUrl,
      apiKey: runtime.config.apiKey,
      path: '/v1/observability/traces',
      body: payload,
    });
  } catch {
    await handleRetry(runtime, eventId, attemptCount, 'network_error', null);
    return;
  }

  await handleUploadResponse(runtime, eventId, response, attemptCount);
}

async function handleUploadResponse(
  runtime: UploaderRuntime,
  eventId: string,
  response: Response,
  attemptCount: number,
): Promise<void> {
  const status = response.status;

  if (status === 401 || status === 403) {
    runtime.paused = true;
    runtime.lastErrorCode = `auth_${status}`;
    await scheduleCloudTraceRetry(
      runtime.pool,
      eventId,
      runtime.lastErrorCode,
      new Date(Date.now() + runtime.config.maxRetryMs),
    );
    return;
  }

  if (status === 200 || status === 201) {
    await markCloudTraceSent(runtime.pool, eventId);
    runtime.lastSuccessAt = new Date();
    clearAuthPause(runtime);
    return;
  }

  if (status === 408 || status === 429 || status >= 500) {
    const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
    await handleRetry(runtime, eventId, attemptCount, `http_${status}`, retryAfter);
    return;
  }

  await markCloudTraceDeadLetter(runtime.pool, eventId, `http_${status}`);
  runtime.lastErrorCode = `http_${status}`;
}

async function handleRetry(
  runtime: UploaderRuntime,
  eventId: string,
  attemptCount: number,
  errorCode: string,
  retryAfterMs: number | null,
): Promise<void> {
  runtime.lastErrorCode = errorCode;
  if (attemptCount + 1 >= runtime.config.maxAttempts) {
    await markCloudTraceDeadLetter(runtime.pool, eventId, errorCode);
    return;
  }
  const backoff = Math.min(
    runtime.config.maxRetryMs,
    runtime.config.baseRetryMs * 2 ** attemptCount,
  );
  const delayMs = retryAfterMs ?? backoff;
  await scheduleCloudTraceRetry(
    runtime.pool,
    eventId,
    errorCode,
    new Date(Date.now() + delayMs),
  );
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}