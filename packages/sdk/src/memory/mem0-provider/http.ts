/**
 * @file HTTP Helper for Mem0 Provider
 *
 * Re-exports shared HTTP helpers bound to the 'mem0' provider name.
 */

import { createHttpClient } from '../shared/http-client';
export type { HttpOptions } from '../shared/http-client';

const client = createHttpClient('mem0');

export const fetchJson = client.fetchJson;
export const fetchVoid = client.fetchVoid;
export const fetchJsonOrNull = client.fetchJsonOrNull;
export const deleteIgnore404 = client.deleteIgnore404;
