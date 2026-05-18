/**
 * Structured audit event types for memory operations.
 *
 * Defines the event schema for all security-relevant operations:
 * ingest, retrieval, AUDN decisions, trust scoring, and sanitization.
 *
 * Phase 3 security baseline. Events are emitted as structured JSON to stdout
 * (like retrieval-trace.ts). Persistence to a database audit table is a
 * follow-up task — this module defines the schema and serialization only.
 */

/** All auditable operation types. */
export type AuditAction =
  | 'memory:ingest'
  | 'memory:retrieve'
  | 'memory:update'
  | 'memory:delete'
  | 'memory:reset-source'
  | 'memory:supersede'
  | 'memory:contradiction-preserved'
  | 'sanitization:block'
  | 'sanitization:warn'
  | 'trust:below-threshold'
  | 'lesson:match'
  | 'lesson:created'
  | 'consensus:filter'
  | 'deferred-audn:reconcile';

/** A single audit event with structured payload. */
export interface AuditEvent {
  timestamp: string;
  action: AuditAction;
  userId: string;
  memoryId?: string;
  sourceSite?: string;
  detail: Record<string, unknown>;
}

/** Configuration for the audit logger. */
export interface AuditConfig {
  enabled: boolean;
  logToStdout: boolean;
}

const DEFAULT_CONFIG: AuditConfig = {
  enabled: true,
  logToStdout: true,
};

let currentConfig: AuditConfig = { ...DEFAULT_CONFIG };

/** Set audit logger configuration. */
export function configureAudit(config: Partial<AuditConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/** Reset audit logger to default configuration. */
export function resetAuditConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

/** Check if audit logging is currently enabled. */
export function isAuditEnabled(): boolean {
  return currentConfig.enabled;
}

/**
 * Build a structured audit event.
 * Pure function — does not emit or persist, just constructs the event object.
 */
export function buildAuditEvent(
  action: AuditAction,
  userId: string,
  detail: Record<string, unknown>,
  options?: AuditEventOptions,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    action,
    userId,
    memoryId: options?.memoryId,
    sourceSite: options?.sourceSite,
    detail,
  };
}

/**
 * Serialize an audit event to a single-line JSON string.
 * Prefixed with [AUDIT] for easy grep/filtering in log streams.
 */
export function serializeAuditEvent(event: AuditEvent): string {
  return `[AUDIT] ${JSON.stringify(event)}`;
}

/**
 * Emit an audit event. Currently writes to stdout as single-line JSON.
 * No-op when audit logging is disabled.
 */
/** Options for audit event emission. */
export interface AuditEventOptions {
  memoryId?: string;
  sourceSite?: string;
  lessonId?: string;
  workspaceId?: string;
}

export function emitAuditEvent(
  action: AuditAction,
  userId: string,
  detail: Record<string, unknown>,
  options?: AuditEventOptions,
): void {
  if (!currentConfig.enabled) return;

  const event = buildAuditEvent(action, userId, detail, options);
  if (currentConfig.logToStdout) {
    console.log(serializeAuditEvent(event));
  }
}
