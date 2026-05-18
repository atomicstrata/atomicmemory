/**
 * @file Hindsight Provider Wire Types
 *
 * Contains the narrow response shapes consumed directly by the Hindsight
 * provider implementation. These are intentionally provider-internal and map
 * only documented Hindsight OpenAPI fields, keeping speculative aliases out of
 * the backend-neutral SDK memory contract.
 */

import type { HindsightOperation } from './types';

export interface RawListResponse {
  items: Record<string, unknown>[];
  total: number;
}

export interface RawReflectResponse {
  text: string;
  based_on?: { memories?: Array<{ id?: string | null }> } | null;
}

export interface RawHealthResponse {
  status?: string;
  ok?: boolean;
  version?: string;
}

export interface RawOperationsResponse {
  bank_id?: string;
  operations: HindsightOperation[];
}

export interface RawOperationStatusResponse {
  operation_id: string;
  operation_type?: string | null;
  created_at?: string | null;
  status?: string;
  error_message?: string | null;
  retry_count?: number | null;
  next_retry_at?: string | null;
}
