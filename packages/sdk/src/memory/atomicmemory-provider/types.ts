/**
 * @file AtomicMemory Provider Configuration
 */

import type { MetaFactFilterConfig } from '../meta-fact-filter';

export interface AtomicMemoryProviderConfig {
  /** Base URL of the atomicmemory-core instance, e.g. `http://localhost:3050`. */
  apiUrl: string;
  /** Optional bearer token forwarded as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Request timeout in milliseconds. Defaults to 30_000. */
  timeout?: number;
  /**
   * API version segment prepended to every core-facing route path.
   *
   * Core mounts its routers under `/v1/memories` and `/v1/agents` (see
   * atomicmemory-core/src/app/create-app.ts:31-32). The SDK prepends
   * `/${apiVersion}` to all route calls so hitting a pre-v1 deployment
   * or future versioned deployments only requires a config change, not
   * a code change.
   *
   * Defaults to `'v1'` — the current mount point on core. Pass `''` to
   * disable prefixing entirely (useful only against legacy deployments
   * that never versioned their mount).
   */
  apiVersion?: string;
  /**
   * Opt-in post-retrieval filter that drops extraction-style meta-facts
   * (e.g. "The user asked for the user's name.", "As of <date>, X is a term
   * mentioned in the conversation.") before they reach the caller.
   *
   * Empirically motivated by `benchmarks/alignbench/RESULTS.md`: meta-facts
   * are the dominant cause of partner-visible recall failures, outranking
   * real user facts at thin cosine margins. Filtering them post-hoc gives
   * cleaner search results today while a durable upstream extraction-prompt
   * fix rolls out in core.
   *
   * When omitted, the filter is OFF and behaviour is unchanged. Set
   * `{ enabled: true }` to activate with the built-in pattern set, or pass
   * additional `patterns` / `mode` per `MetaFactFilterConfig`.
   */
  metaFactFilter?: MetaFactFilterConfig;
}

/** Default timeout for AtomicMemory provider HTTP requests (ms). */
export const ATOMICMEMORY_DEFAULT_TIMEOUT = 30_000;

/**
 * Default API version segment. Matches core's current mount at
 * atomicmemory-core/src/app/create-app.ts:31-32.
 */
export const ATOMICMEMORY_DEFAULT_API_VERSION = 'v1';
