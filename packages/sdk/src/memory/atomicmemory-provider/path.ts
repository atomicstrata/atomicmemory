/**
 * @file Route-path helpers for the AtomicMemory provider.
 *
 * Core mounts its routers under `/v1/memories` and `/v1/agents`
 * (atomicmemory-core/src/app/create-app.ts:31-32). The SDK prepends a
 * configurable version segment to every core-facing path so callers
 * can point at different mounts (pre-v1 legacy, future v2, etc.) by
 * changing config instead of code.
 */

/**
 * Normalize the `apiVersion` config value to a leading-slash prefix
 * with no trailing slash: `'v1'` → `'/v1'`, `'/v1/'` → `'/v1'`,
 * `''` → `''`. Empty string disables prefixing.
 */
export function normalizeApiVersion(apiVersion: string): string {
  const trimmed = apiVersion.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  return `/${trimmed}`;
}
