/**
 * Shared date-parsing utility for the llmwiki bridge.
 *
 * `new Date(someString)` returns an `Invalid Date` object (not a thrown error) when
 * the input is unparseable. `Invalid Date` JSON-serializes to `null`, which is
 * data-loss for any downstream consumer that stores or transmits Memory records.
 *
 * `parseDate` centralises the safe fallback so both the snapshot provider and the
 * live-source mapper use the same behaviour: a parseable ISO string → the correct
 * Date; anything unparseable → epoch (new Date(0)).
 */

/**
 * Parse an ISO date string, falling back to epoch on any invalid/NaN input.
 *
 * @param iso - A date string to parse (ISO 8601 recommended).
 * @returns A valid `Date` instance; never an `Invalid Date`.
 */
export function parseDate(iso: string): Date {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}
