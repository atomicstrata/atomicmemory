/**
 * @file Shared NUL-byte (U+0000) scanning utilities.
 *
 * Postgres cannot store `\x00` in `text` / `varchar` / `jsonb`; a client string
 * carrying one raises at the driver and turns documented input into a 500
 * instead of a validated 400. These helpers are the single source of truth for
 * detecting that byte, reused by:
 *   - the request-boundary guards (`middleware/reject-nul-bytes.ts`),
 *   - the per-field schema refines (`schemas/common.ts`), and
 *   - the pg query-layer backstop (`db/nul-guard.ts`).
 *
 * NUL is built via `fromCharCode` so this source file carries no raw NUL byte
 * (which git and editors mangle).
 */

/** U+0000. Module-local; callers use {@link containsNoNul} / {@link scanForNul}. */
const NUL_CHAR = String.fromCharCode(0);

/** True when `s` contains no NUL byte. Used by per-field Zod refines. */
export const containsNoNul = (s: string): boolean => !s.includes(NUL_CHAR);

/** Outcome of {@link scanForNul}. */
export type NulScanResult = 'clean' | 'nul' | 'too-deep';

/**
 * Default maximum nesting depth for {@link scanForNul}. No legitimate JSON
 * request body or bound parameter nests this deep; a structure that does is
 * treated as a stack-exhaustion probe and rejected rather than walked.
 */
const DEFAULT_MAX_SCAN_DEPTH = 256;

/** A value to scan plus its nesting depth, held on the explicit walk stack. */
interface ScanFrame {
  value: unknown;
  depth: number;
}

/** True for a plain walkable object (not null, not an array, not a Buffer). */
function isWalkableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Buffer.isBuffer(value);
}

/**
 * Visit one frame: report whether its own string content carries a NUL, and
 * push any children (array items / object values) onto `stack` for later
 * visits. Object KEYS are checked here too, since they reach JSONB columns.
 */
function expandFrame(frame: ScanFrame, stack: ScanFrame[]): boolean {
  const { value, depth } = frame;
  if (typeof value === 'string') return value.includes(NUL_CHAR);
  if (Array.isArray(value)) {
    for (const item of value) stack.push({ value: item, depth: depth + 1 });
    return false;
  }
  if (!isWalkableObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key.includes(NUL_CHAR)) return true;
    stack.push({ value: child, depth: depth + 1 });
  }
  return false;
}

/**
 * Iteratively scan every string reachable from `root` — object KEYS and values,
 * array elements, and nested objects — for a raw NUL byte. Uses an explicit
 * stack (never call-stack recursion) and a depth bound, so a crafted
 * deeply-nested payload can neither exhaust the call stack nor be walked
 * unboundedly. `Buffer` values are skipped so raw binary uploads are never
 * treated as text.
 *
 * Returns `'nul'` on the first NUL found (in a key or a string value),
 * `'too-deep'` when the depth bound is crossed, otherwise `'clean'`.
 */
export function scanForNul(
  root: unknown,
  maxDepth: number = DEFAULT_MAX_SCAN_DEPTH,
): NulScanResult {
  const stack: ScanFrame[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop() as ScanFrame;
    if (frame.depth > maxDepth) return 'too-deep';
    if (expandFrame(frame, stack)) return 'nul';
  }
  return 'clean';
}
