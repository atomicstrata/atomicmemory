/**
 * Structured observability for the Filecoin raw-storage lifecycle.
 *
 * Mirrors the `audit-events.ts` shape: typed event payloads emitted
 * as single-line JSON to stdout, prefixed with `[FILECOIN]` for grep
 * / log-aggregator filtering. No metrics framework is invented — the
 * implementation uses log-based aggregation because core does not
 * have a metrics seam today. Operators can derive counters, gauges,
 * and histograms from the event stream.
 *
 * Sanitization is the load-bearing invariant: events MUST NOT carry
 * UCAN proofs, principal keys, codec keys, AES-GCM nonces / tags, or
 * any other credential surface. The module enforces this two ways:
 *
 *   1. The typed `FilecoinEventPayload` is a CLOSED record over a
 *      small set of allow-listed fields. Callers cannot accidentally
 *      pass a wire-shape `raw_storage_metadata` blob.
 *   2. `sanitizeErrorMessage` strips UCAN/`did:key:`/base64-key
 *      lookalikes before they enter the event stream. The function
 *      is exported so the scheduler's `logReconcilerError` and any
 *      future call-site share the same redaction rule.
 *
 * `computePendingAgeSeconds(pendingSince)` is the pure helper for
 * pending-age gauges; it carries a single contract (NULL → null;
 * otherwise integer seconds from the timestamp to `now`) so the
 * metric definition stays in one place.
 */

export type FilecoinEventName =
  | 'filecoin.upload.started'
  | 'filecoin.upload.accepted'
  | 'filecoin.upload.failed'
  | 'filecoin.reconcile.claimed'
  | 'filecoin.reconcile.promoted'
  | 'filecoin.reconcile.archival_failed'
  | 'filecoin.reconcile.stale_claim_recovered'
  | 'filecoin.reconcile.failure'
  | 'filecoin.retrieval.verification_failed'
  | 'filecoin.delete.tombstoned'
  | 'filecoin.delete.unpinned'
  | 'filecoin.hint.malformed';

/**
 * Closed allowlist of fields that may travel on an event payload.
 * Adding a field here is the EXPLICIT permission to surface it on
 * the wire — credentials/proofs/codec keys do not appear and must
 * never be added without a redaction review.
 */
export interface FilecoinEventPayload {
  documentId?: string;
  userId?: string;
  /** Storage provider key as it appears on the row (`'filecoin'`). */
  provider?: string;
  statusBefore?: string;
  statusAfter?: string;
  /** Reconciler claim UUID; never embeds vendor data. */
  claimId?: string;
  /** Categorical, vendor-free (see `FilecoinOnrampErrorCode`). */
  errorCode?: string;
  /** Already-sanitized short message — pass through `sanitizeErrorMessage`. */
  errorMessage?: string;
  /** Operation duration for upload latency aggregation. */
  durationMs?: number;
  /** Reconciler batch size — drives `reconcile_batches_total` aggregation. */
  batchSize?: number;
  /** Reconciler attempt count for the row at the time of the event. */
  reconcileAttempts?: number;
  /** Pending-age gauge sample, computed via `computePendingAgeSeconds`. */
  pendingAgeSeconds?: number;
  /**
   * On-chain `0x…` transaction hash returned by the Synapse SDK's
   * `deletePiece` call (the scheduled-removal tx). Surfaced by the
   * `filecoin.delete.tombstoned` event so operators can correlate
   * a cleanup pass to chain-side gas cost. Internal-only — the
   * field NEVER appears on a route response; the route layer
   * never reads `FilecoinEventPayload`. Phase 7
   * billing/cost-impact-metadata channel for uncertain delete
   * outcomes.
   */
  deleteTxHash?: string;
}

export interface FilecoinEvent {
  event: FilecoinEventName;
  timestamp: string;
  detail: FilecoinEventPayload;
}

/**
 * TypeScript's `FilecoinEventPayload` shape only narrows callers
 * that pass an object LITERAL. A `detail` variable that satisfies
 * the type but also carries extra credential-shaped fields would
 * otherwise serialize verbatim because TS erases the excess at
 * compile time, not run time. `projectPayload` walks the closed
 * field list and copies ONLY those keys; everything else (planted
 * `raw_storage_metadata`, `proof`, `codec`, etc.) is dropped before
 * the payload ever reaches the event stream. `errorMessage` is
 * additionally run through `sanitizeErrorMessage` here so call sites
 * can pass raw probe/transport messages without re-sanitizing at
 * every emit site.
 */
const ALLOWED_PAYLOAD_KEYS = [
  'documentId',
  'userId',
  'provider',
  'statusBefore',
  'statusAfter',
  'claimId',
  'errorCode',
  'errorMessage',
  'durationMs',
  'batchSize',
  'reconcileAttempts',
  'pendingAgeSeconds',
  // Phase 7 billing/cost-impact metadata. Adding this here is
  // the EXPLICIT runtime permission to carry the on-chain
  // `0x…` tx hash on the `filecoin.delete.tombstoned` event —
  // the type-level addition to `FilecoinEventPayload` alone is
  // not enough because `projectPayload` walks the closed
  // runtime list and drops anything not on it. Any other
  // planted field (raw sidecar hints, credentials, vendor
  // responses) still gets stripped.
  'deleteTxHash',
] as const satisfies ReadonlyArray<keyof FilecoinEventPayload>;

function projectPayload(detail: Record<string, unknown>): FilecoinEventPayload {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_PAYLOAD_KEYS) {
    if (!(key in detail)) continue;
    const value = (detail as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] =
      key === 'errorMessage'
        ? sanitizeErrorMessage(value as unknown)
        : value;
  }
  return out as FilecoinEventPayload;
}

export interface FilecoinObservabilityConfig {
  enabled: boolean;
  logToStdout: boolean;
}

const DEFAULT_CONFIG: FilecoinObservabilityConfig = {
  enabled: true,
  logToStdout: true,
};

let currentConfig: FilecoinObservabilityConfig = { ...DEFAULT_CONFIG };

/** Override the module's emission config — used by tests to suppress stdout. */
export function configureFilecoinObservability(
  config: Partial<FilecoinObservabilityConfig>,
): void {
  currentConfig = { ...currentConfig, ...config };
}

export function resetFilecoinObservabilityConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

export function isFilecoinObservabilityEnabled(): boolean {
  return currentConfig.enabled;
}

/**
 * Pure builder — returns the event object without emitting.
 *
 * `detail` is run through `projectPayload` so an object variable carrying extra
 * credential-shaped fields (`raw_storage_metadata`, `proof`,
 * `codec`, …) loses them before the event materialises. Any
 * `errorMessage` is sanitized at the same boundary so call sites
 * are free to pass raw probe/transport messages.
 */
export function buildFilecoinEvent(
  event: FilecoinEventName,
  detail: FilecoinEventPayload,
): FilecoinEvent {
  return {
    event,
    timestamp: new Date().toISOString(),
    detail: projectPayload(detail as unknown as Record<string, unknown>),
  };
}

export function serializeFilecoinEvent(event: FilecoinEvent): string {
  return `[FILECOIN] ${JSON.stringify(event)}`;
}

/**
 * Emit a structured event. No-op when observability is disabled.
 * Tests typically call `configureFilecoinObservability({ logToStdout:
 * false })` and spy on `console.log` directly — keeps assertions
 * decoupled from the prefix string.
 */
export function emitFilecoinEvent(
  event: FilecoinEventName,
  detail: FilecoinEventPayload,
): void {
  if (!currentConfig.enabled) return;
  const built = buildFilecoinEvent(event, detail);
  if (currentConfig.logToStdout) {
    // eslint-disable-next-line no-console
    console.log(serializeFilecoinEvent(built));
  }
}

/**
 * Bounded-length sanitizer for an error message destined for the
 * event stream. Strips:
 *
 *   - `did:key:…` principal-key lookalikes
 *   - long base64/base64url runs (UCAN proofs are ~200+ chars)
 *   - codec key/nonce/tag JSON fragments
 *
 * Final length-cap protects log volume + acts as a defence in depth
 * if a future error type slips through with a structured payload in
 * its message.
 */
export function sanitizeErrorMessage(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
        ? input
        : '';
  return applyRedactionRules(raw).slice(0, MAX_ERROR_MESSAGE_LEN);
}

const MAX_ERROR_MESSAGE_LEN = 200;

function applyRedactionRules(s: string): string {
  return s
    // `did:key:z…` principal-key identifiers
    .replace(/did:key:[A-Za-z0-9_-]+/g, '[REDACTED_PRINCIPAL]')
    // long base64/base64url runs that look like UCAN proofs
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, '[REDACTED_BASE64]')
    // codec/AES-GCM internal field labels (`key_id`, `nonce`, `tag`)
    // when they appear with a value separator
    .replace(/(key_id|nonce|tag)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    // raw-storage env vars that look credential-bearing
    .replace(/RAW_STORAGE_[A-Z0-9_]*(?:PRIVATE_KEY|TOKEN|SECRET|AUTH)[A-Z0-9_]*/g, '[REDACTED_ENV]');
}

/**
 * Scheduler error-logger shared by the reconciler's `onError` hook
 * (rev-8 §8). Centralized so a future telemetry sink swap touches
 * one call site.
 */
export function logReconcilerError(err: unknown): void {
  const code = extractErrorCode(err);
  emitFilecoinEvent('filecoin.reconcile.failure', {
    errorCode: code,
    errorMessage: sanitizeErrorMessage(err),
  });
}

function extractErrorCode(err: unknown): string {
  if (err instanceof Error) {
    const candidate = (err as unknown as { code?: unknown }).code;
    if (typeof candidate === 'string') return candidate;
  }
  return 'unknown';
}

/**
 * Convert a `raw_storage_pending_since` column value to integer
 * seconds since the row entered `blob_pending`. Rows that never
 * entered `blob_pending` (or were promoted / failed terminally)
 * return `null`.
 *
 * `now` defaults to the wall clock — pass it explicitly in tests for
 * deterministic assertions (no Date.now mocking required).
 */
export function computePendingAgeSeconds(
  pendingSince: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (pendingSince === null || pendingSince === undefined) return null;
  const start = pendingSince instanceof Date ? pendingSince : new Date(pendingSince);
  if (Number.isNaN(start.getTime())) return null;
  const ageMs = now.getTime() - start.getTime();
  if (ageMs < 0) return 0;
  return Math.floor(ageMs / 1000);
}
