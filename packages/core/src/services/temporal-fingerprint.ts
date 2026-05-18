/**
 * Normalized content fingerprints for temporal retrieval protection.
 * Different rows can duplicate the same event text, so protection needs
 * to reason about content identity, not row identity.
 */

export function buildTemporalFingerprint(content: string): string {
  return content
    .replace(/^As of [^,]+,?\s*/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}
