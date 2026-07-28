/**
 * Cloud-connected local configuration types (trace sync + JWT verify).
 */

export interface CloudTraceSyncConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  instanceId: string;
  batchSize: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  pollIntervalMs: number;
  sentRetentionMs: number;
  shutdownDrainMs: number;
  claimStaleMs: number;
  deadLetterRetentionMs: number;
  maxPending: number;
}

export interface CloudJwtConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  /**
   * Optional bound Cloud project for connected-local JWT verification.
   * When null, Core trusts the token's own `project_id` claim.
   */
  projectId: string | null;
  staticKeyFallbackEnabled: boolean;
  legacyDefaultMemoryUserId: string | null;
}

export interface CloudRuntimeHeartbeatPayload {
  core_instance_id: string;
  core_version: string;
  connector_version: string;
  capabilities: string[];
  local_url?: string;
}
