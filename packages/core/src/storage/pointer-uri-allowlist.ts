/**
 * @file Pointer-URI scheme allowlist + validator.
 *
 * Step 5 of the storage-sibling plan. Pointer-mode artifacts carry a
 * caller-supplied URI that the server stores but NEVER fetches; even
 * so, narrowing what schemes can be persisted protects downstream
 * consumers (browser UIs, future server-side prefetchers) from
 * unauthenticated or weak references. Default allowlist is
 * `https://`, `s3://`, `gs://`, `ipfs://`. Operators can opt in
 * `http://` or `local-fs://` via the `RAW_STORAGE_POINTER_URI_SCHEMES`
 * csv knob — adding a scheme is the operator attesting that
 * downstream consumers are safe against that scheme's specific
 * risks.
 *
 * The startup parser fails closed on unknown scheme tokens so
 * typos surface deterministically.
 */

const KNOWN_SCHEMES = ['https', 's3', 'gs', 'ipfs', 'http', 'local-fs'] as const;
type KnownScheme = (typeof KNOWN_SCHEMES)[number];

const DEFAULT_SCHEMES: ReadonlyArray<KnownScheme> = ['https', 's3', 'gs', 'ipfs'];

/**
 * Parse the `RAW_STORAGE_POINTER_URI_SCHEMES` env value. Empty /
 * undefined → defaults. Unknown tokens → throw.
 */
export function parsePointerUriSchemes(
  value: string | undefined,
): ReadonlyArray<KnownScheme> {
  if (value === undefined || value.trim().length === 0) return DEFAULT_SCHEMES;
  const entries = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (entries.length === 0) return DEFAULT_SCHEMES;
  const out: KnownScheme[] = [];
  const seen = new Set<KnownScheme>();
  for (const entry of entries) {
    if (!isKnownScheme(entry)) {
      throw new Error(
        `Invalid RAW_STORAGE_POINTER_URI_SCHEMES entry '${entry}'. ` +
          `Must be one of: ${KNOWN_SCHEMES.join(', ')}.`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(`Duplicate scheme '${entry}' in RAW_STORAGE_POINTER_URI_SCHEMES.`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Extract the URI scheme (lowercase, no trailing colon) without
 * relying on `URL` parsing — `s3://` and `ipfs://` are not
 * recognised by the WHATWG URL parser. Returns null when the input
 * does not start with a scheme.
 */
export function extractScheme(uri: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//.exec(uri);
  if (match === null) return null;
  return match[1].toLowerCase();
}

/**
 * Test whether `uri` carries an allowlisted scheme. The active
 * allowlist is captured at startup and passed in from the route
 * layer — keeps this module free of any config singleton import.
 */
export function isAllowlistedPointerUri(
  uri: string,
  allowlist: ReadonlyArray<KnownScheme>,
): boolean {
  const scheme = extractScheme(uri);
  if (scheme === null) return false;
  return allowlist.includes(scheme as KnownScheme);
}

function isKnownScheme(value: string): value is KnownScheme {
  return (KNOWN_SCHEMES as readonly string[]).includes(value);
}
