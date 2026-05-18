/**
 * Shared XML escaping utility used by retrieval formatting modules.
 */

/** Escape special characters for safe embedding in XML/HTML content. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
