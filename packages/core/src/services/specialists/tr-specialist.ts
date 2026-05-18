/**
 * TR (Temporal Reasoning) specialist — DETERMINISTIC (no LLM in hot path).
 *
 * Smoke v5 showed Haiku-in-the-loop pattern hurts: when asked "find the two
 * dates," Haiku returned missing_dates=true even when its own output text
 * cited both dates explicitly. The over-abstention propagated.
 *
 * This version extracts dates from retrieved memories directly via regex +
 * observed_at column, matches them to query anchors via substring, computes
 * the duration in TypeScript, and emits the literal answer that BEAM's
 * judge expects ("21 days between X and Y").
 */

/** Pattern: "how many days/weeks/months between" / "how long between/since/until". */
export function shouldInvokeTrSpecialist(query: string): boolean {
  return /\b(how many (days|weeks|months|years)|how long (between|since|until))\b/i.test(query);
}

export interface TrMemoryInput {
  id: string;
  text: string;
  observedAt?: Date;
}

export interface TrSpecialistDeps {
  memories: ReadonlyArray<TrMemoryInput>;
  query: string;
  /** Unused — kept for API compatibility with the prior LLM version. */
  model?: string;
}

export interface TrSpecialistResult {
  answer: string;
  handled: boolean;
  startDate: Date | null;
  endDate: Date | null;
  durationDays: number | null;
  /** Telemetry: always false in this implementation. */
  usedLlm: boolean;
}

const DAY_MS = 1000 * 60 * 60 * 24;

// ISO YYYY-MM-DD, with optional time
const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ABBR = MONTH_NAMES.map(m => m.slice(0, 3));
const MONTH_PATTERN = new RegExp(
  `\\b(${[...MONTH_NAMES, ...MONTH_ABBR].join('|')})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`,
  'gi',
);

function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  const full = MONTH_NAMES.indexOf(lower);
  return full >= 0 ? full : MONTH_ABBR.indexOf(lower);
}

/** Extract every parseable date from a string, returning Date objects. */
export function extractDatesFromText(text: string, defaultYear?: number): Date[] {
  const out: Date[] = [];
  for (const m of text.matchAll(ISO_DATE_PATTERN)) {
    const d = parseIsoDate(m[0]);
    if (d) out.push(d);
  }
  for (const m of text.matchAll(MONTH_PATTERN)) {
    const month = monthIndex(m[1]);
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : (defaultYear ?? new Date().getUTCFullYear());
    if (month >= 0 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month, day));
      if (!isNaN(d.getTime())) out.push(d);
    }
  }
  return out;
}

/** Identify two anchor phrases from the query (between X and Y / from X to Y). */
function extractAnchorPhrases(query: string): { start: string; end: string } | null {
  const patterns: RegExp[] = [
    /between (.+?) and (.+?)(?:\?|\.|$)/i,
    /from (.+?) (?:to|until) (.+?)(?:\?|\.|$)/i,
    /\b(.+?) (?:to|until|and) (.+?)(?:\?|\.|$)/i,
  ];
  for (const p of patterns) {
    const m = query.match(p);
    if (m?.[1] && m[2]) {
      return { start: m[1].trim(), end: m[2].trim() };
    }
  }
  return null;
}

/** Score how strongly a memory matches an anchor phrase (substring + word-overlap). */
function anchorMatchScore(anchorText: string, memoryText: string): number {
  const anchor = anchorText.toLowerCase();
  const mem = memoryText.toLowerCase();
  if (mem.includes(anchor)) return 1.0;
  const anchorWords = anchor.split(/\s+/).filter(w => w.length > 3);
  if (anchorWords.length === 0) return 0;
  const hits = anchorWords.filter(w => mem.includes(w)).length;
  return hits / anchorWords.length;
}

/** Pick the best-matching memory for an anchor phrase, return its primary date. */
function dateForAnchor(
  anchorText: string,
  memories: ReadonlyArray<TrMemoryInput>,
): Date | null {
  let bestScore = 0.5;
  let bestDate: Date | null = null;
  for (const m of memories) {
    const score = anchorMatchScore(anchorText, m.text);
    if (score < bestScore) continue;
    const candidates: Date[] = [];
    if (m.observedAt) candidates.push(m.observedAt);
    candidates.push(...extractDatesFromText(m.text));
    if (candidates.length > 0) {
      bestScore = score;
      bestDate = candidates[0];
    }
  }
  return bestDate;
}

function formatDurationForQuery(query: string, days: number): string {
  if (/\bweeks?\b/i.test(query)) {
    const weeks = Math.round(days / 7);
    return `${weeks} weeks`;
  }
  if (/\bmonths?\b/i.test(query)) {
    const months = Math.round(days / 30);
    return `${months} months`;
  }
  return `${days} days`;
}

function isoSlice(d: Date): string { return d.toISOString().slice(0, 10); }

export async function runTrSpecialist(
  deps: TrSpecialistDeps,
): Promise<TrSpecialistResult> {
  const empty: TrSpecialistResult = {
    answer: '',
    handled: false,
    startDate: null,
    endDate: null,
    durationDays: null,
    usedLlm: false,
  };

  if (!shouldInvokeTrSpecialist(deps.query)) return empty;

  const handled = { ...empty, handled: true };
  if (deps.memories.length === 0) return handled;

  const anchors = extractAnchorPhrases(deps.query);
  if (!anchors) return handled;

  const startDate = dateForAnchor(anchors.start, deps.memories);
  const endDate = dateForAnchor(anchors.end, deps.memories);
  if (!startDate || !endDate) return handled;

  const days = Math.abs(Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS));
  const dur = formatDurationForQuery(deps.query, days);

  return {
    answer: `${dur} between ${anchors.start} (${isoSlice(startDate)}) and ${anchors.end} (${isoSlice(endDate)}).`,
    handled: true,
    startDate,
    endDate,
    durationDays: days,
    usedLlm: false,
  };
}
