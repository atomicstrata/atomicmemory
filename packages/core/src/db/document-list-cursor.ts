/**
 * Phase D — opaque base64 cursor helpers for the document list /
 * recovery / passport-feed endpoints.
 *
 * Cursor encodes `{ sortAt, sortId }`: a tuple that is strictly
 * less-than-comparable in the underlying SQL using `(sortAt, sortId) <
 * ($cursor.sortAt, $cursor.sortId)`. Callers pick which column drives
 * the sort (`raw_documents.created_at` for the standalone-list and
 * recovery feeds; the grouped passport-feed uses
 * `MAX(memories.created_at)` for memory-backed rows and
 * `raw_documents.created_at` for synthetic ones).
 *
 * The cursor is base64-url-encoded JSON so it round-trips through
 * query strings cleanly. Callers must validate `decodeListCursor`'s
 * `null` return as "malformed cursor" and 400 — the helper does NOT
 * throw on bad input so route handlers can map invalid cursors to a
 * 400 instead of a 500. ISO date strings on the wire keep the cursor
 * human-readable in logs.
 *
 * Phase D review-fix: structural validation extends past "is a
 * non-empty string" — `sortAt` MUST be a parseable ISO 8601 timestamp
 * and `sortId` MUST be a UUID. Without that, a structurally valid
 * base64url cursor like
 * `{"sortAt":"not-a-date","sortId":"not-a-uuid"}` would slip past
 * the cursor decoder and hit the underlying SQL cast (`$N::timestamptz`
 * / `$N::uuid`), producing a 500 from Postgres instead of the
 * intended 400 invalid_cursor.
 */

const CURSOR_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-emitted cursor `sortAt` is always `Date#toISOString()`, which
 * produces ISO-8601 UTC with millisecond precision and a trailing `Z`
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`). Tightening the validator to this
 * exact shape (plus a `Date` round-trip below) rejects parseable-but-
 * non-server formats like `"2026-05-10"` or `"May 10 2026"` that
 * `Date.parse` would otherwise admit. This stops a caller (or
 * attacker) from crafting a cursor whose `sortAt` parses to a real
 * timestamp but does not correspond to a value the cursor encoder
 * could ever have emitted.
 */
const CURSOR_SORT_AT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface DocumentListCursor {
  sortAt: string;
  sortId: string;
}

/** Base64url encode a UTF-8 string (RFC 4648 §5; no padding). */
function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Inverse of {@link base64urlEncode}. Returns null on malformed input. */
function base64urlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Encode a `(sortAt, sortId)` tuple to an opaque cursor string.
 * `sortAt` should already be ISO 8601; the helper does not coerce
 * Date instances on purpose, so callers see the formatting bug at
 * source if they forget to `.toISOString()`.
 */
export function encodeListCursor(cursor: DocumentListCursor): string {
  return base64urlEncode(JSON.stringify(cursor));
}

/**
 * Decode an opaque cursor string. Returns null on missing input,
 * malformed base64, malformed JSON, or a payload that doesn't carry
 * both fields with the right types.
 */
export function decodeListCursor(raw: string | undefined | null): DocumentListCursor | null {
  if (raw === undefined || raw === null || raw.length === 0) return null;
  const decoded = base64urlDecode(raw);
  if (decoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.sortAt !== 'string' || typeof obj.sortId !== 'string') return null;
  if (obj.sortAt.length === 0 || obj.sortId.length === 0) return null;
  // Validate sortAt against the exact server-emitted ISO UTC
  // millisecond shape AND a Date round-trip. The regex covers the
  // syntactic shape; the round-trip catches values like
  // `"2026-13-99T..."` that match the regex but don't represent
  // real dates. Together this rejects every cursor that could not
  // have come from this server's `Date#toISOString()`.
  if (!CURSOR_SORT_AT_REGEX.test(obj.sortAt)) return null;
  const sortAtDate = new Date(obj.sortAt);
  if (Number.isNaN(sortAtDate.getTime())) return null;
  if (sortAtDate.toISOString() !== obj.sortAt) return null;
  // Validate sortId is a UUID the SQL `::uuid` cast will accept.
  if (!CURSOR_UUID_REGEX.test(obj.sortId)) return null;
  return { sortAt: obj.sortAt, sortId: obj.sortId };
}
