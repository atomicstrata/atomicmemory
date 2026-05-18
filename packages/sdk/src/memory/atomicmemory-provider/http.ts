/**
 * @file HTTP Helper for AtomicMemory Provider
 *
 * Re-exports shared HTTP helpers bound to the 'atomicmemory' provider name.
 */

import { createHttpClient } from '../shared/http-client';
export type { HttpOptions } from '../shared/http-client';

const client = createHttpClient('atomicmemory');

export const fetchJson = client.fetchJson;
export const fetchVoid = client.fetchVoid;
export const fetchJsonOrNull = client.fetchJsonOrNull;
export const deleteIgnore404 = client.deleteIgnore404;
