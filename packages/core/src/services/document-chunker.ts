/**
 * Deterministic text chunker for the document pipeline (Phase 2).
 *
 * Pure function: same (text, options) → same chunks. No timing, no
 * randomness, no provider state. Each chunk carries an absolute
 * character offset range, a content_hash, a stable index, and a token
 * estimate; the index field is what the active-unique partial index on
 * `document_chunks` keys on alongside `chunker_version`.
 *
 * Phase 2 ships a single chunker_version (`PHASE2_CHUNKER_VERSION`).
 * If the algorithm changes meaningfully, bump the constant — that
 * triggers a fresh insert generation rather than colliding with the
 * old run on the unique index.
 *
 * See `the large-file ingestion design notes`
 * Phase 2.
 */

import { createHash } from 'node:crypto';

/**
 * Character size of one chunk before word-boundary trimming. ~250 tokens
 * for `text-embedding-3-small`'s typical English-text ratio (4 chars/token);
 * well under the 8192-token model limit.
 */
const DEFAULT_CHUNK_SIZE = 1500;

/**
 * Overlap between adjacent chunks. ~10% of chunk size keeps adjacent
 * sentences findable via either chunk without exploding the chunk count.
 */
const DEFAULT_CHUNK_OVERLAP = 150;

/** Reject chunks that fall below this size after trimming. */
const DEFAULT_MIN_CHUNK_SIZE = 100;

/**
 * Pinned chunker identifier. Bump when the algorithm output changes for
 * the same input text — that lets the active-unique index treat the new
 * generation as fresh inserts rather than colliding with prior runs.
 */
export const PHASE2_CHUNKER_VERSION = 'phase2-fixed-v1';

/** Pinned parser identifier. Phase 2 accepts text input only. */
export const PHASE2_PARSER_VERSION = 'phase2-text-v1';

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
}

export interface ChunkResult {
  chunkIndex: number;
  content: string;
  contentHash: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

/**
 * Chunk `text` deterministically. Returns `[]` for empty or
 * whitespace-only input.
 */
export function chunkText(text: string, options: ChunkOptions = {}): ChunkResult[] {
  if (!text || text.trim().length === 0) return [];

  const opts = resolveOptions(options);
  if (text.length <= opts.chunkSize) {
    const leading = text.length - text.trimStart().length;
    const trailing = text.length - text.trimEnd().length;
    const trimmed = text.slice(leading, text.length - trailing);
    return trimmed.length === 0
      ? []
      : [makeChunk(0, trimmed, leading, text.length - trailing)];
  }

  return slidingWindowChunks(text, opts);
}

/** Fingerprint a chunk's content; stable across runs for byte-identical input. */
export function hashChunkContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Whole-text fingerprint, used by the indexer's idempotency check.
 * Distinct helper so tests can pin both invariants independently.
 */
export function hashIndexedText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ResolvedChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
  minChunkSize: number;
}

function resolveOptions(input: ChunkOptions): ResolvedChunkOptions {
  const chunkSize = Math.max(1, input.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const chunkOverlap = clampOverlap(input.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, chunkSize);
  const minChunkSize = Math.max(1, Math.min(input.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE, chunkSize));
  return { chunkSize, chunkOverlap, minChunkSize };
}

function clampOverlap(requested: number, chunkSize: number): number {
  if (requested < 0) return 0;
  // Overlap must leave room to advance past it on each step; cap at half.
  return Math.min(requested, Math.floor(chunkSize / 2));
}

function slidingWindowChunks(text: string, opts: ResolvedChunkOptions): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  let cursor = 0;
  let chunkIndex = 0;
  while (cursor < text.length) {
    const window = openWindow(text, cursor, opts);
    if (window.content.length >= opts.minChunkSize) {
      chunks.push(makeChunk(chunkIndex, window.content, window.charStart, window.charEnd));
      chunkIndex++;
    }
    if (window.advanceTo >= text.length) break;
    cursor = advanceCursor(window.advanceTo, opts.chunkOverlap, cursor);
  }
  return chunks;
}

interface ChunkWindow {
  content: string;
  charStart: number;
  charEnd: number;
  /**
   * Position at which the *raw* (pre-trim) window ended. The cursor uses
   * this — not charEnd — to advance, so a chunk that trimmed N trailing
   * whitespace chars still moves the cursor past them on the next step.
   */
  advanceTo: number;
}

function openWindow(text: string, cursor: number, opts: ResolvedChunkOptions): ChunkWindow {
  const rawEnd = Math.min(cursor + opts.chunkSize, text.length);
  const wordEnd = preserveWordBoundary(text, cursor, rawEnd, opts.minChunkSize);
  // Recompute the offsets so they exactly bound the trimmed content; this
  // is the invariant downstream relies on (text.slice(charStart, charEnd)
  // === content), and downstream callers — provenance audit, future raw
  // re-fetch — would otherwise see ranges that include leading/trailing
  // whitespace not present in the chunk's stored content.
  const slice = text.slice(cursor, wordEnd);
  const leading = slice.length - slice.trimStart().length;
  const trailing = slice.length - slice.trimEnd().length;
  const charStart = cursor + leading;
  const charEnd = wordEnd - trailing;
  const content = slice.slice(leading, slice.length - trailing);
  return { content, charStart, charEnd, advanceTo: wordEnd };
}

/**
 * Walk back from `rawEnd` to the previous whitespace so the chunk doesn't
 * end mid-word. Bails out (returning rawEnd unchanged) if no whitespace
 * is found within the [cursor + minChunkSize, rawEnd) window — that
 * keeps the slider from collapsing on inputs with no spaces.
 */
function preserveWordBoundary(
  text: string,
  cursor: number,
  rawEnd: number,
  minChunkSize: number,
): number {
  if (rawEnd >= text.length) return rawEnd;
  const lower = cursor + minChunkSize;
  for (let i = rawEnd; i > lower; i--) {
    if (/\s/.test(text[i - 1])) return i;
  }
  return rawEnd;
}

function advanceCursor(charEnd: number, overlap: number, prevCursor: number): number {
  const next = charEnd - overlap;
  // Guard against the case where overlap >= last window length, which
  // would otherwise make the cursor stand still and loop.
  return next > prevCursor ? next : charEnd;
}

function makeChunk(
  chunkIndex: number,
  content: string,
  charStart: number,
  charEnd: number,
): ChunkResult {
  return {
    chunkIndex,
    content,
    contentHash: hashChunkContent(content),
    charStart,
    charEnd,
    tokenCount: estimateTokens(content),
  };
}

/**
 * Cheap token estimate: ~4 chars / token for English ASCII. We intentionally
 * don't use a real tokenizer here — that would couple the chunker to the
 * embedding model and add a heavy dependency. The number is metadata for
 * downstream cost reporting, not a control.
 */
function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}
