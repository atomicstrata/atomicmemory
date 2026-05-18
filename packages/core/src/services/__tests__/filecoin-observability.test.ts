/**
 * Unit coverage for the Filecoin observability module.
 *
 * The load-bearing assertions are the sanitization ones: a planted
 * credential / proof / codec internal MUST never appear on a built
 * event, on a serialized event, OR on the emitted stdout line. The
 * remaining tests lock the event taxonomy, the pure pending-age
 * helper, and the scheduler error-logger plumbing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildFilecoinEvent,
  computePendingAgeSeconds,
  configureFilecoinObservability,
  emitFilecoinEvent,
  isFilecoinObservabilityEnabled,
  logReconcilerError,
  resetFilecoinObservabilityConfig,
  sanitizeErrorMessage,
  serializeFilecoinEvent,
  type FilecoinEventName,
} from '../filecoin-observability.js';

/**
 * Shared `console.log` spy lifecycle. Both `emitFilecoinEvent` and
 * `logReconcilerError` describe blocks need the same spy + restore;
 * registering at top level (one beforeEach / afterEach pair) keeps
 * fallow from flagging the per-block `vi.spyOn(...) + .mockRestore()`
 * pattern as a clone. Tests that don't introspect the spy ignore it.
 */
let consoleLogSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  resetFilecoinObservabilityConfig();
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy?.mockRestore();
  consoleLogSpy = null;
});

function currentLogSpy(): ReturnType<typeof vi.spyOn> {
  if (consoleLogSpy === null) throw new Error('console.log spy not initialized');
  return consoleLogSpy;
}

describe('buildFilecoinEvent', () => {
  it('builds an event with the supplied name + detail + ISO timestamp', () => {
    const event = buildFilecoinEvent('filecoin.upload.started', {
      documentId: 'doc-1',
      userId: 'user-1',
      provider: 'filecoin',
    });
    expect(event.event).toBe('filecoin.upload.started');
    expect(event.detail.documentId).toBe('doc-1');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('covers the closed event-name taxonomy', () => {
    const names: FilecoinEventName[] = [
      'filecoin.upload.started',
      'filecoin.upload.accepted',
      'filecoin.upload.failed',
      'filecoin.reconcile.claimed',
      'filecoin.reconcile.promoted',
      'filecoin.reconcile.archival_failed',
      'filecoin.reconcile.stale_claim_recovered',
      'filecoin.reconcile.failure',
      'filecoin.retrieval.verification_failed',
      'filecoin.delete.tombstoned',
      'filecoin.delete.unpinned',
    ];
    for (const name of names) {
      expect(buildFilecoinEvent(name, {}).event).toBe(name);
    }
  });
});

describe('buildFilecoinEvent — runtime allowlist enforcement', () => {
  it('drops unknown fields a caller variable smuggled past the type system', () => {
    // A `Record<string, unknown>` variable that happens to ALSO
    // satisfy `FilecoinEventPayload` shape. TS structural typing
    // doesn't catch the excess keys here because the value is
    // `unknown`-typed first, then cast.
    const smuggled = {
      documentId: 'doc-1',
      provider: 'filecoin',
      raw_storage_metadata: { codec: { name: 'aes_gcm', nonce: 'AAAA', tag: 'BBBB', key_id: 'v1' } },
      proof: 'EXFILTRATED_UCAN_PROOF',
      codec: { name: 'aes_gcm', nonce: 'NONCE' },
      storage_uri: 'ipfs://bafy-secret',
    } as unknown as import('../filecoin-observability.js').FilecoinEventPayload;
    const event = buildFilecoinEvent('filecoin.upload.accepted', smuggled);
    // Allowed keys survive
    expect(event.detail.documentId).toBe('doc-1');
    expect(event.detail.provider).toBe('filecoin');
    // Smuggled keys are gone
    const json = JSON.stringify(event);
    expect(json).not.toContain('raw_storage_metadata');
    expect(json).not.toContain('EXFILTRATED_UCAN_PROOF');
    expect(json).not.toContain('NONCE');
    expect(json).not.toContain('storage_uri');
    expect(json).not.toContain('ipfs://bafy-secret');
    expect(json).not.toContain('"codec":');
    expect((event.detail as unknown as Record<string, unknown>).codec).toBeUndefined();
    expect((event.detail as unknown as Record<string, unknown>).proof).toBeUndefined();
  });

  it('sanitizes errorMessage centrally so call sites can pass raw probe messages', () => {
    // The reconciler passes raw `verify.message` / probe error text;
    // the central allowlist projection MUST redact before emit.
    const planted = 'did:key:z6MkpZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const event = buildFilecoinEvent('filecoin.retrieval.verification_failed', {
      documentId: 'doc-1',
      errorCode: 'content_hash_mismatch',
      errorMessage: `expected hash X got Y from ${planted}`,
    });
    expect(event.detail.errorMessage).toBeDefined();
    expect(event.detail.errorMessage!).not.toContain(planted);
    expect(event.detail.errorMessage!).toContain('[REDACTED');
  });

  it('preserves benign errorMessage content (no over-redaction)', () => {
    const event = buildFilecoinEvent('filecoin.reconcile.archival_failed', {
      errorCode: 'reconcile_attempts_exhausted',
      errorMessage: 'pending after 100 reconciliation attempts',
    });
    expect(event.detail.errorMessage).toBe(
      'pending after 100 reconciliation attempts',
    );
  });

  it('omits explicit-undefined values from the projected payload', () => {
    const event = buildFilecoinEvent('filecoin.upload.started', {
      documentId: 'doc-1',
      userId: undefined,
    });
    expect('userId' in event.detail).toBe(false);
  });

  it('Phase 7: deleteTxHash survives the runtime projection on filecoin.delete.tombstoned events', () => {
    // The previous Phase 7 commit added `deleteTxHash` to the
    // TypeScript `FilecoinEventPayload` interface but forgot to
    // add it to `ALLOWED_PAYLOAD_KEYS`. `projectPayload` walks
    // the runtime list and would silently drop the field, so
    // the actual `filecoin.delete.tombstoned` event would be
    // missing the on-chain tx hash. This test pins the runtime
    // contract by exercising `buildFilecoinEvent` directly +
    // round-tripping through `JSON.stringify` — the same path
    // the stdout emit takes.
    const planted = '0xPLANTED_CHAIN_TX_HASH_DO_NOT_LEAK';
    const event = buildFilecoinEvent('filecoin.delete.tombstoned', {
      provider: 'filecoin',
      deleteTxHash: planted,
      statusAfter: 'blob_tombstoned',
    });
    expect(event.detail.deleteTxHash).toBe(planted);
    const json = JSON.stringify(event);
    expect(json).toContain(planted);
    expect(json).toContain('"deleteTxHash"');
  });

  it('Phase 7: smuggled sidecar fields are STILL stripped even when deleteTxHash is allowed', () => {
    // Adding `deleteTxHash` to the runtime allowlist must NOT
    // open a hole for the other planted credential/sidecar
    // fields. Pin the redaction invariant for this event name.
    // The fixture intentionally omits an allowlisted `provider`
    // key — the test above already pins the allowed-keys-survive
    // path; this one focuses on the smuggled-fields-get-stripped
    // invariant.
    const smuggled = {
      deleteTxHash: '0xfeed',
      statusAfter: 'blob_tombstoned',
      raw_storage_metadata: { piece_id: '7', data_set_id: '42' },
      private_key: 'PLANTED-KEY',
      ipfs_cid: 'bafy-PLANTED-LEAK',
      proof: 'EXFILTRATED_UCAN_PROOF',
    } as unknown as import('../filecoin-observability.js').FilecoinEventPayload;
    const event = buildFilecoinEvent('filecoin.delete.tombstoned', smuggled);
    expect(event.detail.deleteTxHash).toBe('0xfeed');
    const json = JSON.stringify(event);
    expect(json).not.toContain('raw_storage_metadata');
    expect(json).not.toContain('PLANTED-KEY');
    expect(json).not.toContain('bafy-PLANTED-LEAK');
    expect(json).not.toContain('EXFILTRATED_UCAN_PROOF');
    expect(json).not.toContain('"piece_id"');
    expect(json).not.toContain('"data_set_id"');
    expect(json).not.toContain('"ipfs_cid"');
  });
});

describe('emitFilecoinEvent — Phase 7 deleteTxHash reaches stdout', () => {
  it('the [FILECOIN] line for filecoin.delete.tombstoned contains the deleteTxHash + statusAfter', () => {
    // Hook the actual emit path (console.log), not the
    // `vi.spyOn(emitFilecoinEvent)` shortcut — the previous
    // cleanup-leak test intercepted BEFORE `projectPayload`
    // ran, so it missed the runtime-allowlist bug. This test
    // exercises the full chain: `emitFilecoinEvent` →
    // `buildFilecoinEvent` → `projectPayload` →
    // `serializeFilecoinEvent` → `console.log`.
    const planted = '0xPLANTED_CHAIN_TX_HASH_RUNTIME_PROOF';
    emitFilecoinEvent('filecoin.delete.tombstoned', {
      provider: 'filecoin',
      deleteTxHash: planted,
      statusAfter: 'blob_tombstoned',
    });
    expect(currentLogSpy()).toHaveBeenCalledTimes(1);
    const line = currentLogSpy().mock.calls[0]![0] as string;
    expect(line.startsWith('[FILECOIN] ')).toBe(true);
    const parsed = JSON.parse(line.slice('[FILECOIN] '.length));
    expect(parsed.event).toBe('filecoin.delete.tombstoned');
    expect(parsed.detail.deleteTxHash).toBe(planted);
    expect(parsed.detail.statusAfter).toBe('blob_tombstoned');
    expect(parsed.detail.provider).toBe('filecoin');
  });
});

describe('serializeFilecoinEvent', () => {
  it('produces a single-line JSON string prefixed with [FILECOIN]', () => {
    const line = serializeFilecoinEvent(
      buildFilecoinEvent('filecoin.upload.accepted', { provider: 'filecoin' }),
    );
    expect(line.startsWith('[FILECOIN] ')).toBe(true);
    const json = JSON.parse(line.slice('[FILECOIN] '.length));
    expect(json.event).toBe('filecoin.upload.accepted');
    expect(json.detail.provider).toBe('filecoin');
  });
});

describe('emitFilecoinEvent', () => {
  it('writes a [FILECOIN] line to stdout when enabled', () => {
    emitFilecoinEvent('filecoin.reconcile.promoted', { documentId: 'doc-x' });
    const spy = currentLogSpy();
    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] as [string];
    expect(line.startsWith('[FILECOIN] ')).toBe(true);
    expect(line).toContain('"event":"filecoin.reconcile.promoted"');
  });

  it('no-ops when observability is disabled', () => {
    configureFilecoinObservability({ enabled: false });
    expect(isFilecoinObservabilityEnabled()).toBe(false);
    emitFilecoinEvent('filecoin.upload.failed', { documentId: 'doc-y' });
    expect(currentLogSpy()).not.toHaveBeenCalled();
  });

  it('no-ops stdout but stays enabled when logToStdout=false', () => {
    configureFilecoinObservability({ logToStdout: false });
    emitFilecoinEvent('filecoin.upload.started', { documentId: 'doc-z' });
    expect(isFilecoinObservabilityEnabled()).toBe(true);
    expect(currentLogSpy()).not.toHaveBeenCalled();
  });
});

describe('sanitizeErrorMessage', () => {
  it('redacts did:key principal identifiers', () => {
    const out = sanitizeErrorMessage(
      new Error('upload failed for did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9JSrqyebTQvLpJfXxKpqJ'),
    );
    expect(out).not.toContain('z6MkpTHR8VNsBxYAAWHut2Geadd9JSrqyebTQvLpJfXxKpqJ');
    expect(out).toContain('[REDACTED');
  });

  it('redacts long base64 runs that look like UCAN proofs', () => {
    const proof = 'A'.repeat(120) + '/zXc==';
    const out = sanitizeErrorMessage(new Error(`UCAN proof: ${proof}`));
    expect(out).not.toContain(proof);
    expect(out).toContain('[REDACTED_BASE64]');
  });

  it('redacts codec internals (key_id / nonce / tag) when they appear with a value separator', () => {
    const msg = 'codec decode failed key_id=v1 nonce=AAECAwQFBgcICQoLDA tag=ZmFrZS10YWctdmFsdWU';
    const out = sanitizeErrorMessage(new Error(msg));
    expect(out).toMatch(/key_id=\[REDACTED\]/);
    expect(out).toMatch(/nonce=\[REDACTED\]/);
    expect(out).toMatch(/tag=\[REDACTED\]/);
  });

  it('redacts credential-shaped RAW_STORAGE_* env-var leaks by name', () => {
    const msg = 'config error reading RAW_STORAGE_FILECOIN_PRIVATE_KEY at startup';
    const out = sanitizeErrorMessage(msg);
    expect(out).not.toContain('RAW_STORAGE_FILECOIN_PRIVATE_KEY');
    expect(out).toContain('[REDACTED_ENV]');
  });

  it('caps message length to a bounded value', () => {
    const out = sanitizeErrorMessage(new Error('A'.repeat(5000)));
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('returns empty string for non-Error / non-string inputs', () => {
    expect(sanitizeErrorMessage(undefined)).toBe('');
    expect(sanitizeErrorMessage(null)).toBe('');
    expect(sanitizeErrorMessage(42)).toBe('');
    expect(sanitizeErrorMessage({})).toBe('');
  });

  it('passes a benign HTTP message through (minus its long token, if any)', () => {
    expect(sanitizeErrorMessage(new Error('http 503 from gateway'))).toContain(
      'http 503',
    );
  });
});

describe('logReconcilerError', () => {
  it('emits a filecoin.reconcile.failure event with sanitized message + code', () => {
    const err = Object.assign(new Error('timeout reading did:key:z6MkpZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'), {
      code: 'timeout',
    });
    logReconcilerError(err);
    const spy = currentLogSpy();
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('"event":"filecoin.reconcile.failure"');
    expect(line).toContain('"errorCode":"timeout"');
    expect(line).not.toContain('z6MkpZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
  });

  it('falls back to errorCode="unknown" for errors with no .code', () => {
    logReconcilerError(new Error('boom'));
    const line = currentLogSpy().mock.calls[0]![0] as string;
    expect(line).toContain('"errorCode":"unknown"');
  });

  it('handles non-Error throwables without crashing', () => {
    logReconcilerError('string error');
    const spy = currentLogSpy();
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('"errorCode":"unknown"');
  });
});

describe('computePendingAgeSeconds', () => {
  it('returns null for null / undefined / unparseable values', () => {
    expect(computePendingAgeSeconds(null)).toBeNull();
    expect(computePendingAgeSeconds(undefined)).toBeNull();
    expect(computePendingAgeSeconds('not a timestamp')).toBeNull();
  });

  it('returns integer seconds for ISO strings', () => {
    const now = new Date('2026-05-11T12:00:42.000Z');
    expect(computePendingAgeSeconds('2026-05-11T11:55:00.000Z', now)).toBe(342);
  });

  it('accepts Date inputs', () => {
    const now = new Date('2026-05-11T12:00:00.000Z');
    const past = new Date('2026-05-11T11:59:30.000Z');
    expect(computePendingAgeSeconds(past, now)).toBe(30);
  });

  it('clamps negative age (future timestamps) to zero', () => {
    const now = new Date('2026-05-11T12:00:00.000Z');
    const future = new Date('2026-05-11T12:00:30.000Z');
    expect(computePendingAgeSeconds(future, now)).toBe(0);
  });
});
