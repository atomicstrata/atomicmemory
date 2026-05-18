/**
 * @file Hindsight Provider Configuration and Wire Types
 *
 * Defines the public configuration surface and provider-specific extension
 * handle types for the Hindsight memory backend. The core SDK provider API
 * remains backend-agnostic; these types are exported so callers that opt into
 * Hindsight-specific operation metadata can do so through named extensions.
 */

import type { IngestInput, Scope } from '../types';

export type HindsightRecallBudget = 'low' | 'mid' | 'high';
export type HindsightTagsMatch = 'any' | 'all' | 'any_strict' | 'all_strict';

export interface HindsightProviderConfig {
  /** Hindsight API base URL, e.g. `https://api.hindsight.vectorize.io`. */
  apiUrl: string;
  /** Optional bearer token for Hindsight Cloud or protected self-hosted APIs. */
  apiKey?: string;
  /** Request timeout in milliseconds. Defaults to 30_000. */
  timeout?: number;
  /** API version path segment. Defaults to `v1`. */
  apiVersion?: string;
  /** Hindsight project path segment. Defaults to `default`. */
  projectId?: string;
  /** Recall search depth fallback. Request-level typed override is deferred. */
  defaultBudget?: HindsightRecallBudget;
  /** Fallback context token budget for package/recall requests. */
  defaultMaxTokens?: number;
}

export interface HindsightRetainItem {
  content: string;
  context?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface HindsightRetainRequest {
  items: HindsightRetainItem[];
  async?: boolean;
}

export interface HindsightRetainResponse {
  success?: boolean;
  bank_id?: string;
  items_count?: number;
  async?: boolean;
  operation_id?: string;
  operation_ids?: string[];
  usage?: Record<string, unknown>;
}

export interface HindsightOperation {
  id: string;
  task_type?: string;
  items_count?: number;
  document_id?: string | null;
  created_at?: string;
  status?: string;
  error_message?: string | null;
  retry_count?: number;
  next_retry_at?: string;
}

export interface HindsightOperationsPage {
  bank_id?: string;
  operations: HindsightOperation[];
}

export interface HindsightRetainHandle {
  retain(input: IngestInput): Promise<HindsightRetainResponse>;
}

export interface HindsightOperationsHandle {
  list(scope: Scope): Promise<HindsightOperationsPage>;
  get(scope: Scope, operationId: string): Promise<HindsightOperation | null>;
}

export const HINDSIGHT_DEFAULT_TIMEOUT = 30_000;
export const HINDSIGHT_DEFAULT_API_VERSION = 'v1';
export const HINDSIGHT_DEFAULT_PROJECT_ID = 'default';
/** Hindsight's documented default source-fact token budget for reflect/recall examples. */
export const HINDSIGHT_DEFAULT_MAX_TOKENS = 4_096;
export const HINDSIGHT_SCOPE_TAGS_MATCH: HindsightTagsMatch = 'all_strict';
