/**
 * @file HTTP Helper for Hindsight Provider
 *
 * Re-exports shared HTTP helpers bound to the `hindsight` provider name so
 * errors, rate limits, auth headers, and timeouts are classified consistently
 * with the SDK's other HTTP-backed memory providers.
 */

import { createHttpClient } from '../shared/http-client';
export type { HttpOptions } from '../shared/http-client';

const client = createHttpClient('hindsight');

export const fetchJson = client.fetchJson;
export const fetchJsonOrNull = client.fetchJsonOrNull;
export const deleteIgnore404 = client.deleteIgnore404;
