/**
 * @file Mem0 Context Provider Types
 *
 * V2-compatible type definitions used by the webapp's Mem0SdkAdapter.
 * These types bridge the gap between the webapp's expected interface
 * and the V3 MemoryProvider architecture.
 */

/**
 * Metadata attached to a context when adding via addContext().
 * Matches the shape expected by mem0-sdk-adapter.server.ts.
 */
export interface ContextMetadata {
  userId: string;
  source?: string;
  type?: 'conversation' | 'document' | 'note' | 'preference' | string;
  platform?: string;
  title?: string;
  url?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Metadata attached when updating a context via updateContext().
 */
export interface DocumentMetadata {
  source?: string;
  userId?: string;
  type?: 'conversation' | 'document' | 'note' | 'preference' | string;
  platform?: string;
  title?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Configuration for the Mem0ContextProvider bridge.
 */
export interface Mem0ContextProviderConfig {
  /** API key for the Mem0 instance */
  apiKey?: string;
  /** Mem0 server base URL (e.g. "http://localhost:8888") */
  host: string;
  /** API style — currently only 'oss' is supported */
  apiStyle: 'oss';
  /** Default user ID used when no per-request userId is provided */
  defaultUserId: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Path prefix for API endpoints (e.g. '/v1' for hosted, '' for OSS). Defaults to '/v1'. */
  pathPrefix?: string;
}

/**
 * A context record returned by getContext().
 */
export interface ContextRecord {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A search result returned by searchContext().
 */
export interface ContextSearchResult {
  id: string;
  contextId: string;
  content: string;
  /** Raw Mem0 backend score. For local OSS Mem0 this is distance-like, so lower is better. */
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Result from addContext(), containing the Mem0 server-assigned ID.
 */
export interface AddContextResult {
  /** Mem0's internal ID for the created memory. Use this for get/update/delete. */
  memoryId: string;
  /** The caller-supplied contextId, stored in metadata. */
  contextId: string;
  content: string;
}

/**
 * Options for searchContext().
 */
export interface ContextSearchOptions {
  userId: string;
  maxResults?: number;
  /** Minimum similarity [0, 1]. The bridge converts this to a max allowed raw Mem0 distance. */
  threshold?: number;
}
