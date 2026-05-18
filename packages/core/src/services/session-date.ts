/**
 * Shared parser for transcript-level session dates.
 *
 * Benchmark and SDK callers can include a first-line header:
 *   - `[Session date: ...]` — preferred explicit form
 *   - `[<time_anchor> | Turn N]` or `[<time_anchor>]` — BEAM transcript form
 *     where `<time_anchor>` is `Month-Day-Year` or any Date-parseable string
 *
 * Core uses this date as the logical observation timestamp for extraction,
 * storage backdating, and context packaging.
 *
 * IMPORTANT: BEAM transcripts also produce bare turn markers like `[Turn 43]`
 * when the loader splits a session mid-stream. The captured `Turn 43` would
 * pass `Date.parse()` (which interprets the trailing number as a year — e.g.
 * 2043). To prevent year corruption we require the captured anchor to look
 * dated (contains a month name OR a 4-digit year) before passing to Date.parse.
 */

const SESSION_DATE_PATTERN = /^\[Session date:\s*([^\]]+)\]/i;
const BEAM_ANCHOR_PATTERN = /^\[([^|\]]+?)(?:\s*\|\s*Turn\s+\d+)?\]\s/i;
// Lookahead validators for what counts as a real date string. Together they
// reject `Turn 43`, `Turn 134`, `code block`, etc.
const HAS_YEAR_4 = /\b\d{4}\b/;
const HAS_MONTH_NAME = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const STARTS_WITH_TURN = /^\s*turn\b/i;

export function extractSessionTimestamp(conversationText: string): string | null {
  const firstLine = conversationText.split('\n', 1)[0] ?? '';
  const explicit = firstLine.match(SESSION_DATE_PATTERN);
  if (explicit?.[1]) return explicit[1].trim();
  const beam = firstLine.match(BEAM_ANCHOR_PATTERN);
  if (!beam?.[1]) return null;
  const candidate = beam[1].trim();
  // Reject bare turn markers and other non-date captures.
  if (STARTS_WITH_TURN.test(candidate)) return null;
  if (!HAS_YEAR_4.test(candidate) && !HAS_MONTH_NAME.test(candidate)) return null;
  return normalizeAnchor(candidate);
}

/**
 * BEAM anchors look like `March-15-2024`. JS Date.parse() accepts
 * `March 15 2024` (spaces) but rejects the hyphenated form. Replace
 * inner hyphens with spaces so Date.parse() succeeds. Other formats
 * (ISO, RFC) pass through unchanged.
 */
function normalizeAnchor(anchor: string): string {
  if (/^[A-Za-z]+-\d{1,2}-\d{4}$/.test(anchor)) return anchor.replace(/-/g, ' ');
  return anchor;
}

export function parseSessionDate(conversationText: string): Date | null {
  const timestamp = extractSessionTimestamp(conversationText);
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveSessionDate(explicitTimestamp: Date | undefined, conversationText: string): Date | undefined {
  return explicitTimestamp ?? parseSessionDate(conversationText) ?? undefined;
}
