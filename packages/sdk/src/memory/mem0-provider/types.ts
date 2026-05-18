/**
 * @file Mem0 Provider Configuration
 *
 * Configuration types for the Mem0 memory provider, which connects
 * to a local or hosted Mem0 instance via its REST API.
 */

export interface Mem0ProviderConfig {
  /** Mem0 API base URL (e.g. "https://api.mem0.ai" hosted or "http://localhost:8888" OSS) */
  apiUrl: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** API key for hosted Mem0 instances */
  apiKey?: string;
  /** Whether to enable LLM inference on ingest (default true) */
  defaultInfer?: boolean;
  /**
   * When true, ingest sends infer=false synchronously for fast return,
   * then fires a background re-ingest with infer=true (deferred AUDN).
   * Only applies when the effective infer value would be true.
   * Default: false (single-call behavior).
   */
  deferInference?: boolean;
  /**
   * Path prefix for memory-identifier endpoints (ingest, get, delete, list).
   * - '/v1' (default) for hosted Mem0 (api.mem0.ai): /v1/memories/, /v1/memories/{id}/
   * - '' for OSS self-hosted Mem0: /memories/, /memories/{id}/
   *
   * Note: search uses the v2 endpoint (`/v2/memories/search/` hosted, or
   * `/memories/search/` OSS) regardless of this prefix, per mem0 2.0's
   * split of search from the v1 family.
   */
  pathPrefix?: string;
  /**
   * Optional organization ID for enterprise-scoped operations (mem0 2.0+).
   * Sent as top-level `org_id` on search and ingest bodies when set.
   */
  orgId?: string;
  /**
   * Optional project ID for enterprise-scoped operations (mem0 2.0+).
   * Sent as top-level `project_id` on search and ingest bodies when set.
   */
  projectId?: string;
}

/** Default timeout for Mem0 provider HTTP requests (ms). */
export const MEM0_DEFAULT_TIMEOUT = 30_000;
