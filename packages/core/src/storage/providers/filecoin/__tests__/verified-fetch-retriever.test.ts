/**
 * @file Phase 6 — verified-fetch retriever tests.
 *
 * The retriever sits BEHIND the Filecoin provider boundary and
 * carries a strict security contract documented in
 * `retriever.ts`'s file header. These tests pin the observable
 * invariants WITHOUT touching a real IPFS network:
 *
 *   - **CID, not URL**: the type signature accepts a parsed
 *     `CID` only. A runtime guard rejects anything that
 *     bypasses the types.
 *   - **`ipfs://` construction**: the implementation builds the
 *     URL from the supplied CID's canonical multibase string —
 *     verified by inspecting the resource argument passed to
 *     the mocked verified-fetch.
 *   - **Bounded lifecycle**: `fetch.stop()` is invoked on every
 *     code path (success, 404, vendor failure, timeout).
 *   - **Sanitized errors**: raw vendor messages never appear in
 *     the surfaced error; only the closed
 *     `verified_fetch_*` codes do.
 *   - **No credentials / private-IP exposure**: the constructor
 *     options include `allowLocal: false` and
 *     `allowInsecure: false`. Asserted via the call site spy.
 *   - **Deterministic timeout**: vitest fake timers prove the
 *     timeout fires + the controller is aborted, never real
 *     wall-clock waits.
 *   - **Bounded body**: an over-cap response throws
 *     `verified_fetch_body_too_large`.
 */

import { describe, expect, it, vi } from 'vitest';
import { CID } from 'multiformats/cid';
import { FilecoinProviderError } from '../errors.js';
import { VerifiedFetchRetriever } from '../verified-fetch-retriever.js';
import { REAL_PIECE_CID_A } from '../../../__tests__/filecoin-cid-fixtures.js';

const mockCreateVerifiedFetch = vi.fn();
vi.mock('@helia/verified-fetch', () => ({
  createVerifiedFetch: (...args: unknown[]) => mockCreateVerifiedFetch(...args),
}));

const PARSED_CID = CID.parse(REAL_PIECE_CID_A);
const PLAINTEXT = Buffer.from('verified-fetch plaintext payload — phase 6 evaluation');

function makeVerifiedFetchMock(behavior: 'ok' | 'not-found' | 'vendor-error' | 'never-settle' | 'oversized', payload?: Uint8Array): {
  fetch: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  observedResource: { current: string | CID | null };
  observedSignal: { current: AbortSignal | undefined };
} {
  const observedResource: { current: string | CID | null } = { current: null };
  const observedSignal: { current: AbortSignal | undefined } = { current: undefined };
  const stop = vi.fn(async () => undefined);
  const fetch = vi.fn(async (resource: string | CID, opts?: { signal?: AbortSignal }) => {
    observedResource.current = resource;
    observedSignal.current = opts?.signal;
    if (behavior === 'never-settle') {
      return new Promise<Response>(() => undefined);
    }
    if (behavior === 'not-found') {
      return new Response(null, { status: 404 });
    }
    if (behavior === 'vendor-error') {
      throw new Error('PLANTED-VENDOR-MESSAGE peer=12D3KooFOO multiaddr=/ip4/PRIVATE');
    }
    if (behavior === 'oversized') {
      return new Response(Buffer.from(payload ?? Buffer.alloc(0)));
    }
    return new Response(Buffer.from(payload ?? PLAINTEXT));
  });
  const callable = Object.assign(fetch, { stop });
  return { fetch: callable, stop, observedResource, observedSignal };
}

describe('VerifiedFetchRetriever — happy path', () => {
  it('builds `ipfs://<canonical>` from a parsed CID and returns the body', async () => {
    mockCreateVerifiedFetch.mockReset();
    const { fetch, stop, observedResource } = makeVerifiedFetchMock('ok');
    mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);
    const retriever = new VerifiedFetchRetriever();
    const result = await retriever.get(PARSED_CID);
    expect(observedResource.current).toBe(`ipfs://${REAL_PIECE_CID_A}`);
    expect(Buffer.compare(result.body, PLAINTEXT)).toBe(0);
    expect(result.ipfsCid).toBe(REAL_PIECE_CID_A);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('initializes verified-fetch with `allowLocal=false` and `allowInsecure=false`', async () => {
    mockCreateVerifiedFetch.mockReset();
    const { fetch } = makeVerifiedFetchMock('ok');
    mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);
    await new VerifiedFetchRetriever().get(PARSED_CID);
    expect(mockCreateVerifiedFetch).toHaveBeenCalledWith({
      allowLocal: false,
      allowInsecure: false,
    });
  });
});

describe('VerifiedFetchRetriever — sanitized errors', () => {
  it('maps a vendor throw to verified_fetch_failed without echoing the vendor message', async () => {
    mockCreateVerifiedFetch.mockReset();
    const { fetch, stop } = makeVerifiedFetchMock('vendor-error');
    mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);
    const retriever = new VerifiedFetchRetriever();
    let caught: unknown;
    try {
      await retriever.get(PARSED_CID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_failed');
    const message = (caught as Error).message;
    // Sanitization: no peer-id, multiaddr, planted message, or
    // private-IP literal leaks into the error message surfacing
    // to the caller.
    expect(message).not.toContain('PLANTED-VENDOR-MESSAGE');
    expect(message).not.toContain('12D3KooFOO');
    expect(message).not.toContain('multiaddr');
    expect(message).not.toContain('/ip4/');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('maps a 404 response to verified_fetch_not_found', async () => {
    mockCreateVerifiedFetch.mockReset();
    const { fetch, stop } = makeVerifiedFetchMock('not-found');
    mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);
    let caught: unknown;
    try {
      await new VerifiedFetchRetriever().get(PARSED_CID);
    } catch (err) {
      caught = err;
    }
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_not_found');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized body with verified_fetch_body_too_large', async () => {
    mockCreateVerifiedFetch.mockReset();
    const oversized = Buffer.alloc(2048, 0x61);
    const { fetch, stop } = makeVerifiedFetchMock('oversized', oversized);
    mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);
    const retriever = new VerifiedFetchRetriever({ maxBodyBytes: 1024 });
    let caught: unknown;
    try {
      await retriever.get(PARSED_CID);
    } catch (err) {
      caught = err;
    }
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_body_too_large');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('VerifiedFetchRetriever — bounded lifecycle', () => {
  it('fires the timeout deterministically via fake timers, surfaces verified_fetch_timeout, calls stop()', async () => {
    vi.useFakeTimers();
    try {
      mockCreateVerifiedFetch.mockReset();
      const { fetch, stop, observedSignal } = makeVerifiedFetchMock('never-settle');
      mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);
      const retriever = new VerifiedFetchRetriever();
      const promise = retriever.get(PARSED_CID, { timeoutMs: 1000 });
      const rejection = expect(promise).rejects.toMatchObject({
        errorCode: 'verified_fetch_timeout',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(observedSignal.current?.aborted).toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('race-loser cleanup: fetch resolves AFTER timeout — body reader is cancelled, no hang', async () => {
    // Phase 6 review blocker fix. Scenario the old code missed:
    //   1. `get()` starts. `runBoundedRetrieval` races the
    //      operation against the timeout sentinel.
    //   2. Vendor's `fetch()` is slow; timeout sentinel wins
    //      first. `get()` rejects with `verified_fetch_timeout`
    //      and `fetch.stop()` runs.
    //   3. THEN the vendor's `fetch()` finally resolves with a
    //      Response. The operation promise's continuation runs
    //      `classifyResponse` and `readBoundedBody`. The signal
    //      is already aborted, but `addEventListener('abort', …)`
    //      does NOT fire for a past event — so without the
    //      synchronous `signal.aborted` check, `reader.read()`
    //      would hang in the background.
    // This test pins the synchronous check: when the late-
    // resolving fetch finally settles, `readBoundedBody` sees
    // `signal.aborted === true`, calls `reader.cancel()`, and
    // throws (rejected operation promise is silenced by the
    // outer `.catch(() => undefined)` tail on the race).
    vi.useFakeTimers();
    try {
      mockCreateVerifiedFetch.mockReset();
      let resolveFetch: ((r: Response) => void) | null = null;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const stop = vi.fn(async () => undefined);
      const reader = {
        read: vi.fn(() => new Promise<{ done: boolean; value?: Uint8Array }>(() => undefined)),
        cancel: vi.fn(async () => undefined),
      };
      const responseLike = {
        status: 200,
        ok: true,
        body: { getReader: () => reader },
      } as unknown as Response;
      const fetch = Object.assign(vi.fn(() => fetchPromise), { stop });
      mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);

      const retriever = new VerifiedFetchRetriever();
      const promise = retriever.get(PARSED_CID, { timeoutMs: 1000 });
      const rejection = expect(promise).rejects.toMatchObject({
        errorCode: 'verified_fetch_timeout',
      });
      // Step 1+2: timeout wins, outer get rejects, stop runs.
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(stop).toHaveBeenCalledTimes(1);
      // Step 3: the vendor's fetch promise resolves LATE, after
      // get() already returned. The operation-promise
      // continuation runs; the race-loser cleanup must cancel
      // the reader synchronously rather than wait on an
      // abort-event that already fired.
      expect(reader.cancel).not.toHaveBeenCalled();
      resolveFetch!(responseLike);
      // Flush microtasks so the post-await continuation runs.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(reader.cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires the timeout when the BODY READ hangs (reader.read never settles); stop() still runs', async () => {
    // Phase 6 blocker fix: the previous implementation raced
    // only the initial fetch promise against the timeout. Once
    // `fetch()` returned a Response, `reader.read()` could hang
    // forever and `get()` would never return. The new
    // `runBoundedRetrieval` wraps the entire fetch + classify +
    // body-read in one `Promise.race` against the timeout
    // sentinel.
    vi.useFakeTimers();
    try {
      mockCreateVerifiedFetch.mockReset();
      const stop = vi.fn(async () => undefined);
      // Reader whose `read()` never settles; matches a real
      // mock-network response that hangs after `fetch()`
      // resolves.
      const reader = {
        read: vi.fn(() => new Promise<{ done: boolean; value?: Uint8Array }>(() => undefined)),
        cancel: vi.fn(async () => undefined),
      };
      // The mocked Response is shape-narrowed to what
      // `runBoundedRetrieval` / `readBoundedBody` actually
      // consume (`status`, `ok`, `body.getReader`). Cast through
      // `unknown` to bypass the TS narrowing on
      // `ReadableStream<Uint8Array>`'s nested buffer-backing
      // type (`ArrayBuffer` vs `ArrayBufferLike`).
      const responseLike = {
        status: 200,
        ok: true,
        body: { getReader: () => reader },
      } as unknown as Response;
      const fetch = Object.assign(
        vi.fn(async () => responseLike),
        { stop },
      );
      mockCreateVerifiedFetch.mockResolvedValueOnce(fetch);
      const retriever = new VerifiedFetchRetriever();
      const promise = retriever.get(PARSED_CID, { timeoutMs: 1000 });
      const rejection = expect(promise).rejects.toMatchObject({
        errorCode: 'verified_fetch_timeout',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(stop).toHaveBeenCalledTimes(1);
      // The abort signal-driven `reader.cancel()` runs too —
      // proves real Web-Streams cleanup hygiene alongside the
      // race back-stop.
      expect(reader.cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VerifiedFetchRetriever — loader/create failures are sanitized', () => {
  it('maps an ERR_MODULE_NOT_FOUND from the load/create path to verified_fetch_unsupported', async () => {
    // The synapse-only omit-optional install fails the optional
    // package's resolution; the operationally meaningful signal
    // is `code === 'ERR_MODULE_NOT_FOUND'`. The retriever's
    // `loadAndCreateVerifiedFetch` catches that code on EITHER
    // the import branch OR the construct branch and surfaces
    // `verified_fetch_unsupported`. Here we exercise the
    // construct-branch variant by making the mocked
    // `createVerifiedFetch` throw the canonical shape — same
    // operational outcome the import-failure path produces,
    // without the vi.doMock + module-reset complexity.
    mockCreateVerifiedFetch.mockReset();
    mockCreateVerifiedFetch.mockImplementationOnce(() => {
      throw Object.assign(new Error('Cannot find module @helia/verified-fetch'), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
    });
    const retriever = new VerifiedFetchRetriever();
    let caught: unknown;
    try {
      await retriever.get(PARSED_CID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_unsupported');
    // No raw module path leaks into the surfaced message.
    expect((caught as Error).message).not.toContain('Cannot find module');
  });

  it('maps a vendor createVerifiedFetch throw to verified_fetch_failed without leaking the raw message', async () => {
    mockCreateVerifiedFetch.mockReset();
    mockCreateVerifiedFetch.mockImplementationOnce(() => {
      throw new Error('PLANTED-CREATE-MESSAGE host=10.0.0.5 peer=12D3KooLEAK');
    });
    const retriever = new VerifiedFetchRetriever();
    let caught: unknown;
    try {
      await retriever.get(PARSED_CID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_failed');
    const message = (caught as Error).message;
    expect(message).not.toContain('PLANTED-CREATE-MESSAGE');
    expect(message).not.toContain('10.0.0.5');
    expect(message).not.toContain('12D3KooLEAK');
  });
});

describe('VerifiedFetchRetriever — type-level CID-only contract + runtime guard', () => {
  it('runtime-rejects a non-CID argument (defence-in-depth past the type check)', async () => {
    mockCreateVerifiedFetch.mockReset();
    const retriever = new VerifiedFetchRetriever();
    let caught: unknown;
    try {
      // Bypassing the TS signature on purpose — a JS caller
      // handing in a raw URL must NOT reach the verified-fetch
      // boundary.
      await retriever.get('ipfs://bafy-attacker-controlled' as unknown as CID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_invalid_cid');
    // The loader was never called — we never even reached the
    // dynamic import of the optional package.
    expect(mockCreateVerifiedFetch).not.toHaveBeenCalled();
  });

  it('rejects an attacker-controlled `toString` that returns a URL (not a real CID parse)', async () => {
    mockCreateVerifiedFetch.mockReset();
    const retriever = new VerifiedFetchRetriever();
    // A duck-typed object whose `toString()` returns a string
    // that LOOKS like a URL. Without real `CID.parse` validation
    // the retriever would build `ipfs://https://attacker...`.
    const attacker = { toString: () => 'https://attacker.example.com/path' } as unknown as CID;
    let caught: unknown;
    try {
      await retriever.get(attacker);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_invalid_cid');
    expect(mockCreateVerifiedFetch).not.toHaveBeenCalled();
  });

  it('rejects an attacker-controlled `toString` whose result is not even a parseable CID', async () => {
    mockCreateVerifiedFetch.mockReset();
    const retriever = new VerifiedFetchRetriever();
    const attacker = { toString: () => 'not-a-cid' } as unknown as CID;
    let caught: unknown;
    try {
      await retriever.get(attacker);
    } catch (err) {
      caught = err;
    }
    expect((caught as FilecoinProviderError).errorCode).toBe('verified_fetch_invalid_cid');
    expect(mockCreateVerifiedFetch).not.toHaveBeenCalled();
  });
});
