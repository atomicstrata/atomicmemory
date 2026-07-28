/**
 * Bearer header helper for Cloud-issued JWT auth in integration tests.
 */

export function jwtAuthHeader(accessToken: string): Record<string, string> {
  if (accessToken.length === 0) {
    throw new Error('jwtAuthHeader: accessToken must be non-empty');
  }
  return { Authorization: `Bearer ${accessToken}` };
}
