/**
 * @file Hook content sanitizers ported from
 * `plugins/claude-code/scripts/lib/atomicmemory.sh`. The Node hook
 * runtime in `run.ts` calls these on `compact_summary` (post-compact),
 * assistant content (stop), and prompt-context retrieval results
 * (user-prompt-submit) so the bundled runtime matches the shell hook's
 * privacy + signal contract: redact obvious secrets, drop
 * code/markdown/XML noise, drop follow-up prompts, strip
 * chain-of-thought tags, and truncate deterministically. Pure
 * functions only — no I/O, no env reads — so they unit-test cleanly
 * and can be reused by any future host.
 *
 * Secret redaction corpus (audit this list when adding new shapes):
 *   - basic-auth in URLs (https://user:pass@host)
 *   - OpenAI-style sk-* keys
 *   - GitHub personal/OAuth/server/refresh tokens (ghp_/gho_/ghu_/ghs_/ghr_)
 *   - Slack bot/user/refresh/legacy tokens (xoxb-/xoxp-/xoxo-/xoxa-)
 *   - Stripe live/test secret keys (sk_live_/sk_test_)
 *   - JWT-shaped three-part base64url (eyJ…)
 *   - Google OAuth access tokens (ya29.…)
 *   - AWS access key IDs (AKIA…)
 *   - Long opaque uppercase tokens (catch-all; runs last)
 * Each pattern has a focused unit test in
 * `src/__tests__/hooks-sanitize.test.ts`.
 */

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // basic-auth in URLs: https://user:pass@host → https://[redacted]@host
  [/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[redacted]@'],
  // OpenAI-style keys (sk-…). Run before Stripe sk_live_/sk_test_ since
  // both start with `sk` but Stripe uses underscores.
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  // Stripe secret keys
  [/sk_(?:live|test)_[A-Za-z0-9]{16,}/g, 'sk_[redacted]'],
  // GitHub tokens — personal access (ghp_), OAuth (gho_), user-to-server
  // (ghu_), server-to-server (ghs_), refresh (ghr_)
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh_[redacted]'],
  // Slack tokens — bot (xoxb-), user (xoxp-), workspace (xoxo-),
  // app-level (xoxa-). Slack tokens are dash-separated triples.
  [/xox[bpoa]-[A-Za-z0-9-]{16,}/g, 'xox[redacted]'],
  // JWTs — three base64url segments separated by dots; the header
  // always starts `eyJ`. Conservative: require the second segment to
  // also start `eyJ` so we don't catch unrelated dotted strings.
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g, 'jwt-[redacted]'],
  // Google OAuth access tokens
  [/ya29\.[A-Za-z0-9_-]{16,}/g, 'ya29.[redacted]'],
  // AWS access key IDs
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[redacted]'],
  // Long opaque uppercase tokens (matches shell's generic catch-all).
  // Run last so the structured patterns above replace first.
  [/[A-Z0-9_]{32,}/g, '[redacted-token]'],
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Char-count truncation with a single-trailing-whitespace cleanup and
 * an explicit `...` suffix when truncation actually fired. Mirrors the
 * shell `am_truncate` behavior used by both summary cleaners. The
 * returned string is guaranteed to be no longer than `max` — the
 * ellipsis budget is reserved out of `max`, not appended to it, so
 * callers can size byte/char windows deterministically (the prompt-
 * context budgeter relies on this strict bound).
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const ELLIPSIS = '...';
  if (max <= ELLIPSIS.length) return text.slice(0, max);
  let clipped = text.slice(0, max - ELLIPSIS.length);
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace > 0) clipped = clipped.slice(0, lastSpace);
  return `${clipped}${ELLIPSIS}`;
}

const FOLLOWUP_PROMPT_RE =
  /^(want me to|do you want me to|would you like me to|if you want|let me know if|should i)([\s?!.]|$)/i;
const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^\s*[-*]\s+/;
const NUMBERED_RE = /^\s*\d+[.)]\s+/;
const WRAPPER_LABEL_RE = /^[A-Za-z][A-Za-z0-9 _-]+\s*\(.*\):$/;
const SECTION_HEADER_RE = /^(example|evidence):$/i;

function shouldDropLine(line: string): boolean {
  if (line.length === 0) return true;
  if (FOLLOWUP_PROMPT_RE.test(line)) return true;
  if (SECTION_HEADER_RE.test(line)) return true;
  if (WRAPPER_LABEL_RE.test(line) && line.length < 140) return true;
  if (line.endsWith(':') && line.length < 80 && !/[.!?]/.test(line)) return true;
  return false;
}

function normalizeLine(line: string): string {
  let out = line.replace(HEADING_RE, '');
  out = out.replace(/\*\*/g, '');
  out = out.replace(/__/g, '');
  out = out.replace(/`/g, '');
  out = out.replace(/[Hh]ere'?s what I found:$/, '');
  out = out.replace(BULLET_RE, '');
  out = out.replace(NUMBERED_RE, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Tag names treated as model chain-of-thought / scratchpad markers.
 * Both the post-compact and the stop cleaners strip these BEFORE the
 * generic summary pass so private reasoning never leaks into either
 * persisted hook record.
 */
const UNSAFE_MODEL_TAGS = ['analysis', 'thinking', 'scratchpad'] as const;

/**
 * Strip every `<tag>...</tag>` block for each tag in `tagNames` in a
 * single tag-identity-tracked pass:
 *
 *   - Tracks a STACK of open unsafe tags (by index into `tagNames`),
 *     not just a depth counter. Mismatched closes — e.g.
 *     `<analysis>x</thinking>` — are treated as a structural
 *     corruption signal and fail closed (drop from the outer-most
 *     unsafe open to EOF). A naive union-depth counter would have
 *     accepted any unsafe close to pop the stack, allowing post-mismatch
 *     "safe" text to leak even though the model never actually closed
 *     the original unsafe span.
 *   - Preserves safe text BEFORE the first unsafe open and AFTER the
 *     stack returns to empty via well-matched closes.
 *   - Fails closed on: unclosed outer span, malformed open (no `>`),
 *     and mismatched close. Chain-of-thought MUST NOT persist.
 */
export function stripUnsafeModelBlocks(
  text: string,
  tagNames: ReadonlyArray<string> = UNSAFE_MODEL_TAGS,
): string {
  const lower = text.toLowerCase();
  const opens = tagNames.map((t) => `<${t.toLowerCase()}`);
  const closes = tagNames.map((t) => `</${t.toLowerCase()}>`);
  const out: string[] = [];
  let cursor = 0;
  let stack: number[] = [];
  // Bound the loop defensively: every iteration either advances the
  // cursor or returns.
  for (let safety = 0; safety <= text.length + 2; safety++) {
    if (cursor >= text.length) break;
    const step = stack.length === 0
      ? enterUnsafeFromSafe(text, lower, opens, cursor, out)
      : advanceInsideUnsafe(text, lower, opens, closes, cursor, stack);
    if (step === null) return out.join('');
    cursor = step.cursor;
    stack = step.stack;
  }
  return out.join('');
}

interface WalkerStep { cursor: number; stack: number[] }

function enterUnsafeFromSafe(
  text: string,
  lower: string,
  opens: ReadonlyArray<string>,
  cursor: number,
  out: string[],
): WalkerStep | null {
  const nextOpen = nextEarliestIndex(lower, opens, cursor);
  if (nextOpen.idx < 0) {
    // No more unsafe content — flush the rest as safe and signal stop.
    out.push(text.slice(cursor));
    return null;
  }
  // Preserve safe text up to the next unsafe open, then enter the span.
  out.push(text.slice(cursor, nextOpen.idx));
  const tagEnd = text.indexOf('>', nextOpen.idx);
  if (tagEnd < 0) return null; // malformed open — drop everything past it
  return { cursor: tagEnd + 1, stack: [nextOpen.which] };
}

function advanceInsideUnsafe(
  text: string,
  lower: string,
  opens: ReadonlyArray<string>,
  closes: ReadonlyArray<string>,
  cursor: number,
  stack: number[],
): WalkerStep | null {
  const nextOpen = nextEarliestIndex(lower, opens, cursor);
  const nextClose = nextEarliestIndex(lower, closes, cursor);
  if (nextClose.idx < 0) return null; // outer unsafe span unclosed
  if (nextOpen.idx >= 0 && nextOpen.idx < nextClose.idx) {
    const tagEnd = text.indexOf('>', nextOpen.idx);
    if (tagEnd < 0) return null;
    return { cursor: tagEnd + 1, stack: [...stack, nextOpen.which] };
  }
  // Close tag MUST match the top of the stack — otherwise the model
  // emitted a structurally corrupt unsafe block (e.g. opened
  // <analysis> but typed </thinking>). Fail closed: drop to EOF.
  if (stack[stack.length - 1] !== nextClose.which) return null;
  return {
    cursor: nextClose.idx + closes[nextClose.which]!.length,
    stack: stack.slice(0, -1),
  };
}

/** Earliest occurrence of any needle in `lower` at or after `from`. */
function nextEarliestIndex(
  lower: string,
  needles: ReadonlyArray<string>,
  from: number,
): { idx: number; which: number } {
  let bestIdx = -1;
  let bestWhich = -1;
  for (let i = 0; i < needles.length; i++) {
    const idx = lower.indexOf(needles[i]!, from);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
      bestIdx = idx;
      bestWhich = i;
    }
  }
  return { idx: bestIdx, which: bestWhich };
}

/**
 * Generic summary cleaner used for the stop hook's assistant content.
 * Strips unsafe model blocks (analysis/thinking/scratchpad) FIRST, then
 * fenced code blocks, follow-up prompts, markdown, and wrapper labels;
 * joins remaining substance into a single line; truncates.
 */
export function cleanSummaryText(text: string, max: number): string {
  const safe = stripUnsafeModelBlocks(text);
  const lines = safe.split('\n');
  const kept: string[] = [];
  let inCodeBlock = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const normalized = normalizeLine(raw.trim());
    if (shouldDropLine(normalized)) continue;
    kept.push(normalized);
  }
  const joined = kept.join(' ').replace(/\s+/g, ' ').trim();
  return truncate(joined, max);
}

const SUMMARY_BLOCK_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i;
const ANY_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9_:-]*[^>]*>/g;

/**
 * Cleaner used for the post-compact hook's compact_summary input.
 * Strips unsafe model blocks (analysis/thinking/scratchpad), extracts
 * the inner text of `<summary>...</summary>` when present, then runs
 * the generic summary cleaner. The stop cleaner already strips unsafe
 * blocks too — running here first avoids any race where stripped
 * content sneaks through `<summary>` extraction.
 */
export function cleanCompactSummaryText(text: string, max: number): string {
  let extracted = stripUnsafeModelBlocks(text);
  const summaryMatch = SUMMARY_BLOCK_RE.exec(extracted);
  if (summaryMatch) extracted = summaryMatch[1] ?? '';
  extracted = extracted.replace(ANY_TAG_RE, '');
  return cleanSummaryText(extracted, max);
}

interface PromptContextOptions {
  /** Per-hit char cap (after redaction). Truncated with `...`. */
  perHitMax: number;
  /** Total combined char cap across all kept hits. */
  totalMax: number;
}

interface PromptContextResult {
  /** Cleaned hit content lines, in the original order. */
  lines: string[];
  /** True when a per-hit truncation OR total-budget cutoff fired. */
  truncated: boolean;
  /** Sum of `lines[i].length`. */
  totalChars: number;
}

/**
 * Sanitize and budget retrieved memory contents before we hand them to
 * a host model as additional context. Prompt-context injection is the
 * highest-risk hook path: a poisoned memory could carry secrets, an
 * injected instruction, embedded newlines that structurally escape
 * the bullet wrapper in `formatAdditionalContext`, model
 * chain-of-thought tags, or megabytes of content — all of which would
 * be funnelled straight back into the next agent turn. Per-hit
 * pipeline (order matters):
 *   1. Strip `<analysis>/<thinking>/<scratchpad>` blocks (so a memory
 *      that was captured before sanitization landed cannot reintroduce
 *      private reasoning into the next turn).
 *   2. Redact secrets (sk-*, gh*_*, AKIA*, JWT, ya29.*, etc.).
 *   3. Flatten CR/LF/tabs/control whitespace to single spaces and
 *      collapse runs — guarantees the rendered bullet stays on one
 *      line, so a multi-line memory cannot inject a fake new bullet
 *      ("- " at column 0) or break out of the markdown structure.
 *   4. Trim, drop empty hits.
 *   5. Apply the strict per-hit cap (truncate reserves the ellipsis
 *      within `cap`) and the running total cap (cuts off remaining
 *      hits once exhausted).
 * Input ordering is preserved.
 *
 * The caller (`run.ts:formatAdditionalContext`) is responsible for
 * the surrounding "Treat as untrusted reference" warning.
 */
export function sanitizePromptContext(
  contents: ReadonlyArray<string>,
  options: PromptContextOptions,
): PromptContextResult {
  const lines: string[] = [];
  let totalChars = 0;
  let truncated = false;
  for (const raw of contents) {
    const flattened = flattenForBullet(redactSecrets(stripUnsafeModelBlocks(raw)));
    if (!flattened) continue;
    const remainingBudget = options.totalMax - totalChars;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }
    const cap = Math.min(options.perHitMax, remainingBudget);
    const capped = truncate(flattened, cap);
    // `truncate` strictly guarantees `capped.length <= cap`, which is
    // <= `remainingBudget`, so the running total never exceeds
    // `options.totalMax`. Per-hit and total caps are both enforced
    // exactly, not approximately — callers size the prompt-context
    // window deterministically.
    if (capped.length < flattened.length) truncated = true;
    lines.push(capped);
    totalChars += capped.length;
  }
  return { lines, truncated, totalChars };
}

/**
 * Force the per-hit text onto a single line by replacing CR/LF/tabs
 * and other control characters with spaces, collapsing runs, and
 * trimming. This is what stops a retrieved memory from injecting
 * `\n- fake bullet that overrides earlier instructions` into the
 * additionalContext bullet list.
 */
function flattenForBullet(text: string): string {
  return text
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
