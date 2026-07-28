/**
 * Redacted Cloud trace envelope builder for OSS Core outbound sync.
 *
 * Keeps secrets and verbatim memory/query text out of the durable outbox payload.
 * Summary and evidence fields are allowlisted; unknown keys are dropped.
 */

const CLOUD_TRACE_SCHEMA_VERSION = 2 as const;
const MAX_EVIDENCE_STRING_LEN = 120;

export type CloudTraceOperation =
  | 'memory.ingest'
  | 'memory.update'
  | 'memory.delete'
  | 'memory.search';

export type CloudTraceOutcome = 'success' | 'error';

export interface BuildCloudTraceEnvelopeInput {
  eventId: string;
  coreInstanceId: string;
  occurredAt: string;
  operation: CloudTraceOperation;
  outcome: CloudTraceOutcome;
  durationMs: number;
  summary?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

export interface CloudTraceEnvelopeV2 {
  schema_version: typeof CLOUD_TRACE_SCHEMA_VERSION;
  event_id: string;
  core_instance_id: string;
  occurred_at: string;
  operation: CloudTraceOperation;
  outcome: CloudTraceOutcome;
  duration_ms: number;
  summary: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

/** Summary keys permitted on outbound Cloud trace envelopes. */
const ALLOWED_SUMMARY_KEYS = new Set([
  'user_id',
  'result_count',
  'new_memory_id',
  'previous_memory_id',
  'episode_id',
  'memories_stored',
  'memories_updated',
  'memories_deleted',
  'content_len',
  'query_len',
  'fact_len',
  'operation_detail',
]);

/** Evidence keys permitted on outbound Cloud trace envelopes. */
const ALLOWED_EVIDENCE_KEYS = new Set(['mode', 'source', 'source_site']);

/**
 * Build a version-2 envelope suitable for Cloud trace ingest.
 * Allowlists summary and evidence fields; drops unknown keys and arrays.
 */
export function buildCloudTraceEnvelope(
  input: BuildCloudTraceEnvelopeInput,
): CloudTraceEnvelopeV2 {
  if (!input.eventId || !input.coreInstanceId) {
    throw new Error('cloud trace envelope requires eventId and coreInstanceId');
  }
  if (input.durationMs < 0) {
    throw new Error('durationMs must be non-negative');
  }

  return {
    schema_version: CLOUD_TRACE_SCHEMA_VERSION,
    event_id: input.eventId,
    core_instance_id: input.coreInstanceId,
    occurred_at: input.occurredAt,
    operation: input.operation,
    outcome: input.outcome,
    duration_ms: input.durationMs,
    summary: allowlistSummary(input.summary ?? {}),
    evidence: allowlistEvidence(input.evidence ?? {}),
  };
}

function allowlistSummary(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ALLOWED_SUMMARY_KEYS.has(key)) continue;
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      out[key] = entry;
      continue;
    }
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_EVIDENCE_STRING_LEN) {
      out[key] = entry;
    }
  }
  return out;
}

function allowlistEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ALLOWED_EVIDENCE_KEYS.has(key)) continue;
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_EVIDENCE_STRING_LEN) {
      out[key] = entry;
    }
  }
  return out;
}
