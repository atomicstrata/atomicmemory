/**
 * @file Unit tests for `readFilecoinDataSetIdHint` — the strict
 * reader that decides whether the `raw_storage_metadata.filecoin.
 * data_set_id` sidecar is safe to pass through to the
 * Synapse-backed `head`/`delete` calls.
 *
 * Tests pin the validation contract: a non-empty positive decimal
 * bigint string (regex `^[1-9][0-9]*$`) is the ONLY accepted shape.
 * Anything else returns `null` and fires the
 * `filecoin.hint.malformed` diagnostic with a sanitized error code
 * — never the malformed value itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFilecoinDataSetIdHint, readFilecoinDeleteHints } from '../hints.js';
import * as observability from '../../../../services/filecoin-observability.js';

describe('readFilecoinDataSetIdHint — accepted shape', () => {
  it('returns the bigint string when shape + format match', () => {
    const hints = { filecoin: { data_set_id: '42' } };
    expect(readFilecoinDataSetIdHint(hints)).toBe('42');
  });

  it('accepts large bigint strings beyond 2^53', () => {
    const big = '18446744073709551616'; // 2^64
    expect(readFilecoinDataSetIdHint({ filecoin: { data_set_id: big } })).toBe(big);
  });
});

describe('readFilecoinDataSetIdHint — treated as absent', () => {
  it.each([
    ['undefined hints', undefined],
    ['null hints (cast)', null as unknown as undefined],
    ['empty object', {}],
    ['filecoin sibling missing', { other: { x: 1 } }],
    ['filecoin sibling null', { filecoin: null }],
    ['filecoin sibling is an array', { filecoin: [{ data_set_id: '1' }] }],
    ['filecoin sibling has no data_set_id', { filecoin: { piece_cid: 'baga...' } }],
    ['data_set_id is null', { filecoin: { data_set_id: null } }],
    ['data_set_id is undefined', { filecoin: { data_set_id: undefined } }],
  ])('%s → null (no diagnostic emitted)', (_label, hints) => {
    const spy = vi.spyOn(observability, 'emitFilecoinEvent').mockImplementation(() => {});
    expect(readFilecoinDataSetIdHint(hints as never)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('readFilecoinDataSetIdHint — malformed (returns null AND emits diagnostic)', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(observability, 'emitFilecoinEvent').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it.each([
    ['empty string', '', 'data_set_id_not_positive_decimal_bigint'],
    ['zero', '0', 'data_set_id_not_positive_decimal_bigint'],
    ['negative', '-1', 'data_set_id_not_positive_decimal_bigint'],
    ['hex 0x prefix', '0x2a', 'data_set_id_not_positive_decimal_bigint'],
    ['hex without prefix', '2a', 'data_set_id_not_positive_decimal_bigint'],
    ['float', '1.5', 'data_set_id_not_positive_decimal_bigint'],
    ['scientific', '1e10', 'data_set_id_not_positive_decimal_bigint'],
    ['leading zero', '042', 'data_set_id_not_positive_decimal_bigint'],
    ['leading whitespace', ' 42', 'data_set_id_not_positive_decimal_bigint'],
    ['trailing whitespace', '42 ', 'data_set_id_not_positive_decimal_bigint'],
  ])('rejects %s', (_label, value, expectedCode) => {
    const result = readFilecoinDataSetIdHint({ filecoin: { data_set_id: value } });
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe('filecoin.hint.malformed');
    expect((spy.mock.calls[0]?.[1] as { errorCode?: string }).errorCode).toBe(expectedCode);
  });

  it.each([
    ['number type', 42],
    ['bigint type', 42n],
    ['boolean true', true],
    ['object', { v: '42' }],
    ['array', ['42']],
  ])('rejects %s (non-string type)', (_label, value) => {
    const result = readFilecoinDataSetIdHint({ filecoin: { data_set_id: value as never } });
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    expect((spy.mock.calls[0]?.[1] as { errorCode?: string }).errorCode).toBe(
      'data_set_id_not_a_string',
    );
  });

  it('sanitization: malformed value NEVER appears in the diagnostic payload', () => {
    readFilecoinDataSetIdHint({ filecoin: { data_set_id: '0xdeadbeef' } });
    const payload = JSON.stringify(spy.mock.calls[0]?.[1] ?? {});
    expect(payload).not.toContain('0xdeadbeef');
    expect(payload).not.toContain('deadbeef');
  });

  it('forwards documentId when supplied (correlation), no value leak', () => {
    readFilecoinDataSetIdHint(
      { filecoin: { data_set_id: 'oops' } },
      '11111111-1111-1111-1111-111111111111',
    );
    const arg = spy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(arg['documentId']).toBe('11111111-1111-1111-1111-111111111111');
    expect(JSON.stringify(arg)).not.toContain('oops');
  });
});

describe('readFilecoinDeleteHints — happy paths', () => {
  it('returns both dataSetId and pieceId when sidecar carries a matching copy', () => {
    const hints = {
      filecoin: {
        data_set_id: '42',
        copies: [{ data_set_id: '42', piece_id: '7', provider_id: '1' }],
      },
    };
    expect(readFilecoinDeleteHints(hints)).toEqual({ dataSetId: '42', pieceId: '7' });
  });

  it('prefers a copy whose data_set_id matches the top-level data_set_id', () => {
    const hints = {
      filecoin: {
        data_set_id: '42',
        copies: [
          { data_set_id: '99', piece_id: '111' },
          { data_set_id: '42', piece_id: '7' },
          { data_set_id: '42', piece_id: '8' },
        ],
      },
    };
    expect(readFilecoinDeleteHints(hints)).toEqual({ dataSetId: '42', pieceId: '7' });
  });

  it('falls back to first valid copy when no copy matches top-level data_set_id', () => {
    const hints = {
      filecoin: {
        data_set_id: '42',
        copies: [
          { data_set_id: '99', piece_id: '111' },
          { data_set_id: '100', piece_id: '222' },
        ],
      },
    };
    expect(readFilecoinDeleteHints(hints)).toEqual({ dataSetId: '42', pieceId: '111' });
  });

  it('falls back to first valid copy when top-level data_set_id is missing', () => {
    const hints = {
      filecoin: {
        copies: [{ data_set_id: '99', piece_id: '111' }],
      },
    };
    expect(readFilecoinDeleteHints(hints)).toEqual({ dataSetId: null, pieceId: '111' });
  });
});

describe('readFilecoinDeleteHints — partial / absent', () => {
  it.each([
    ['undefined hints', undefined],
    ['null hints (cast)', null as unknown as undefined],
    ['empty object', {}],
    ['filecoin sibling missing', { other: { x: 1 } }],
    ['filecoin sibling is an array', { filecoin: [{ piece_id: '1', data_set_id: '1' }] }],
    ['no copies array', { filecoin: { data_set_id: '42' } }],
    ['copies is empty array', { filecoin: { data_set_id: '42', copies: [] }}],
    ['copies has no eligible entries', {
      filecoin: { data_set_id: '42', copies: [{ data_set_id: '0', piece_id: '5' }] },
    }],
  ])('%s → pieceId null (no diagnostics for non-string missing fields)', (_label, hints) => {
    const out = readFilecoinDeleteHints(hints as never);
    expect(out.pieceId).toBeNull();
  });
});

describe('readFilecoinDeleteHints — malformed copy entries', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(observability, 'emitFilecoinEvent').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it('rejects copy with non-string piece_id and emits sanitized diagnostic', () => {
    const out = readFilecoinDeleteHints({
      filecoin: { data_set_id: '42', copies: [{ data_set_id: '42', piece_id: 7 }] },
    });
    expect(out.pieceId).toBeNull();
    const codes = spy.mock.calls.map(
      (c: ReadonlyArray<unknown>) => (c[1] as { errorCode?: string }).errorCode,
    );
    expect(codes).toContain('piece_id_not_a_string');
  });

  it('rejects copy with non-positive-decimal piece_id', () => {
    const out = readFilecoinDeleteHints({
      filecoin: { data_set_id: '42', copies: [{ data_set_id: '42', piece_id: '0x10' }] },
    });
    expect(out.pieceId).toBeNull();
    const codes = spy.mock.calls.map(
      (c: ReadonlyArray<unknown>) => (c[1] as { errorCode?: string }).errorCode,
    );
    expect(codes).toContain('piece_id_not_positive_decimal_bigint');
  });

  it('sanitization: rejected piece_id value never appears in any diagnostic payload', () => {
    readFilecoinDeleteHints({
      filecoin: { data_set_id: '42', copies: [{ data_set_id: '42', piece_id: '0xdeadbeef' }] },
    });
    const allPayloads = spy.mock.calls
      .map((c: ReadonlyArray<unknown>) => JSON.stringify(c[1] ?? {}))
      .join('|');
    expect(allPayloads).not.toContain('deadbeef');
  });

  it('skips a malformed copy and picks the next eligible one', () => {
    const out = readFilecoinDeleteHints({
      filecoin: {
        data_set_id: '42',
        copies: [
          { data_set_id: '42', piece_id: '0' },
          { data_set_id: '42', piece_id: '7' },
        ],
      },
    });
    expect(out.pieceId).toBe('7');
  });
});
