/**
 * Small env helpers for Cloud config parsers (isolated from monolithic config.ts).
 */

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

/** Whole decimal integer only — rejects parseInt prefixes like `128junk` / `1.5` / `1e3`. */
const STRICT_POSITIVE_INT = /^[1-9]\d*$/;

function parseStrictPositiveInt(name: string, raw: string): number {
  if (!STRICT_POSITIVE_INT.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  return parseStrictPositiveInt(name, raw);
}

/** Positive integer with an upper bound; invalid or out-of-range values fail closed. */
export function parseBoundedPositiveIntEnv(
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = parseStrictPositiveInt(name, raw);
  if (parsed > max) {
    throw new Error(`${name} must be at most ${max} (got ${parsed})`);
  }
  return parsed;
}

export function parseStrictBoolEnv(name: string, fallback: boolean): boolean {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be 'true' or 'false' (got '${raw}')`);
}
