/**
 * @file Bounded-lifecycle + body-reading helpers for the
 * verified-fetch retriever.
 *
 * Lifted out of `verified-fetch-retriever.ts` so the retriever
 * file stays focused on the `FilecoinRetriever` implementation
 * and this file owns the (subtle) timer-lifetime + race-loser
 * contracts. The retriever wires these helpers together; the
 * helpers do not import the retriever or any optional vendor
 * package. Source-build-safety invariant
 * (`filecoin-pin-lazy-boundary.test.ts`) requires zero static
 * imports of `@helia/verified-fetch` / `@helia/*` etc. from
 * this file.
 *
 * Contract summary:
 *
 *   - `startLifecycle(timeoutMs)` builds an `AbortController` +
 *     a `setTimeout` cleared by `cancel()`. The sentinel
 *     promise rejects with `verified_fetch_timeout` on abort.
 *   - `runBoundedRetrieval` wraps fetch + classify + body-read
 *     in ONE `Promise.race` against the timeout sentinel.
 *   - `readBoundedBody` synchronously short-circuits when
 *     `signal.aborted` is already true (race-loser path) so a
 *     late-resolving fetch cannot leak a hung `reader.read()`.
 *   - `requireParsedCid` re-parses through `CID.parse`; an
 *     attacker-controlled `{ toString: () => 'https://attacker' }`
 *     is rejected.
 *   - `mapVerifiedFetchFailure` collapses any non-typed throw
 *     into the closed `verified_fetch_*` error-code set.
 */

import { CID } from 'multiformats/cid';
import { FilecoinProviderError } from './errors.js';
import type { MinimalVerifiedFetch } from './verified-fetch-vendor.js';

/**
 * Defence-in-depth runtime guard. The TS signature already
 * requires a `CID`, but a JS caller bypassing the types must
 * still be rejected. Critically, "looks like an object with a
 * `toString()`" is NOT sufficient — an attacker-controlled
 * `{ toString: () => 'https://attacker.example.com' }` would
 * otherwise let an `ipfs://https://...` URL escape into
 * verified-fetch. We re-parse the candidate's string form
 * through `multiformats/cid.CID.parse`, which only accepts a
 * real CID multibase string. Returns the canonical multibase
 * form for the caller to consume.
 */
export function requireParsedCid(value: unknown): string {
  const shapedLikeCid =
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toString?: unknown }).toString === 'function';
  if (!shapedLikeCid) throw invalidCidError();
  const candidate = (value as { toString(): unknown }).toString();
  if (typeof candidate !== 'string') throw invalidCidError();
  try {
    return CID.parse(candidate).toString();
  } catch {
    throw invalidCidError();
  }
}

function invalidCidError(): FilecoinProviderError {
  return new FilecoinProviderError(
    'verified_fetch_invalid_cid',
    'Verified-fetch retriever requires a parsed CID instance, not a URL or arbitrary string.',
  );
}

export interface RetrievalLifecycle {
  readonly aborter: AbortController | null;
  readonly timeoutRejection: Promise<never> | null;
  cancel(): void;
}

/**
 * Build the timeout + abort handle for a single retrieval. A
 * non-null `aborter` is created only when `timeoutMs > 0`. The
 * sentinel promise rejects with `verified_fetch_timeout` when
 * the controller fires. `cancel()` clears the underlying timer
 * on the success path so we don't leak a pending `setTimeout`
 * past `get`'s lifetime.
 */
export function startLifecycle(timeoutMs: number | undefined): RetrievalLifecycle {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return { aborter: null, timeoutRejection: null, cancel: (): void => undefined };
  }
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  timer.unref?.();
  const timeoutRejection = new Promise<never>((_, reject) => {
    aborter.signal.addEventListener('abort', () => {
      reject(new FilecoinProviderError(
        'verified_fetch_timeout',
        `Verified-fetch retrieval aborted after ${timeoutMs} ms.`,
      ));
    }, { once: true });
  });
  timeoutRejection.catch(() => undefined);
  return {
    aborter,
    timeoutRejection,
    cancel(): void { clearTimeout(timer); },
  };
}

/**
 * Run the entire fetch + classify + bounded-body-read sequence
 * inside ONE `Promise.race` against the timeout sentinel. Race
 * coverage extends past the initial fetch into body consumption
 * so a vendor whose `reader.read()` never settles still cannot
 * outlast `timeoutMs`. The signal is also forwarded into the
 * body reader so a real Web-Streams implementation cancels its
 * pending read on abort — the race is the deterministic
 * back-stop for mocks / vendors that do not.
 */
export async function runBoundedRetrieval(args: {
  readonly fetch: MinimalVerifiedFetch;
  readonly url: string;
  readonly maxBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly timeoutRejection: Promise<never> | null;
}): Promise<Buffer> {
  const operation = (async () => {
    const response = await args.fetch(
      args.url,
      args.signal !== undefined ? { signal: args.signal } : undefined,
    );
    classifyResponse(response);
    return readBoundedBody(response, args.maxBytes, args.signal);
  })();
  if (args.timeoutRejection !== null) {
    // Attach a no-op tail to the operation promise so its
    // race-loser rejection (e.g. the `verified_fetch_timeout`
    // `readBoundedBody` throws when it sees an already-aborted
    // signal) does NOT surface as `unhandledRejection`. Node's
    // tracker is satisfied; the rejection has nowhere else to
    // go because the outer race already chose the timeout.
    operation.catch(() => undefined);
    return Promise.race([operation, args.timeoutRejection]);
  }
  return operation;
}

function classifyResponse(response: Response): void {
  if (response.status === 404) {
    throw new FilecoinProviderError(
      'verified_fetch_not_found',
      'Verified-fetch retrieval returned 404 — content not available on the IPFS network.',
    );
  }
  if (!response.ok) {
    throw new FilecoinProviderError(
      'verified_fetch_failed',
      `Verified-fetch retrieval failed with status ${response.status}.`,
    );
  }
}

export function mapVerifiedFetchFailure(
  err: unknown,
  aborter: AbortController | null,
  timeoutMs: number | undefined,
): FilecoinProviderError {
  if (err instanceof FilecoinProviderError) return err;
  if (aborter?.signal.aborted) {
    return new FilecoinProviderError(
      'verified_fetch_timeout',
      `Verified-fetch retrieval aborted after ${timeoutMs} ms.`,
    );
  }
  return new FilecoinProviderError('verified_fetch_failed', 'Verified-fetch retrieval failed.');
}

/**
 * Read the response body, enforcing a size cap that protects
 * against unbounded retrieval. Synchronous race-loser exit if
 * `signal.aborted` is already true (the outer race has already
 * chosen the timeout sentinel) — cancels the reader, throws
 * `verified_fetch_timeout`. Otherwise dispatches to one of the
 * two streaming/buffered readers.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (signal?.aborted) await bailAlreadyAborted(reader);
  if (reader === undefined) return readBufferedBody(response, maxBytes);
  return readStreamingBody(reader, maxBytes, signal);
}

async function bailAlreadyAborted(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Promise<never> {
  if (reader !== undefined) {
    try { await reader.cancel(); } catch { /* tear-down only */ }
  }
  throw new FilecoinProviderError(
    'verified_fetch_timeout',
    'Verified-fetch retrieval aborted before body read began.',
  );
}

async function readBufferedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new FilecoinProviderError(
      'verified_fetch_body_too_large',
      `Verified-fetch body exceeded the ${maxBytes}-byte ceiling.`,
    );
  }
  return buf;
}

async function readStreamingBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new FilecoinProviderError(
            'verified_fetch_body_too_large',
            `Verified-fetch body exceeded the ${maxBytes}-byte ceiling.`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await reader.cancel(); } catch { /* tear-down only */ }
  }
  return Buffer.concat(chunks);
}
