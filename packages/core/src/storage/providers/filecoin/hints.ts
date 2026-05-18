/**
 * @file Strict readers for the `filecoin.*` hints adapters MAY
 * consult to short-circuit lookups (`head`) and bypass the SDK's
 * CID→active-piece resolution (`delete`).
 *
 * Source: `raw_storage_metadata.filecoin` sidecar that
 * `FilecoinRawContentStore.put` wrote (`backend.ts`). The
 * reconciler / cleanup loop read `raw_documents.raw_storage_metadata`
 * straight out of the DB and pass it as the generic
 * `RawContentHints` argument; this module is the only place that
 * interprets it.
 *
 * Validation contract: every numeric id field MUST be a non-empty
 * positive decimal `bigint` string (regex `^[1-9][0-9]*$`).
 * Anything else — `0`, negative, hex/`0x...`, floats, scientific
 * notation, surrounding whitespace, non-string types, missing
 * keys, the `filecoin` sibling not being an object — is treated
 * as **absent**. Malformed values NEVER throw; the helper returns
 * `null` and emits a sanitized `filecoin.hint.malformed`
 * diagnostic so an operator can see in observability that a hint
 * was rejected without the malformed value itself crossing the
 * boundary.
 */

import type { RawContentHints } from '../../raw-content-store.js';
import { emitFilecoinEvent } from '../../../services/filecoin-observability.js';

const POSITIVE_DECIMAL_BIGINT = /^[1-9][0-9]*$/;

/**
 * Bundled hints `delete` consumes. `dataSetId` locates the
 * `StorageContext`; `pieceId` bypasses the CID-based active-piece
 * lookup that fails for freshly-uploaded pieces (the live
 * calibration smoke surfaced this failure mode). Either field
 * may be `null` independently — the adapter MUST tolerate partial
 * hints (data_set_id present + piece_id missing falls back to
 * CID-based delete on the resolved context; both missing falls
 * back to the scan path).
 */
export interface FilecoinDeleteHints {
  readonly dataSetId: string | null;
  readonly pieceId: string | null;
}

/**
 * Returns the validated `data_set_id` string, or `null` when the
 * hint is missing or malformed. Callers pass the result straight
 * through to `FilecoinProviderClient.head({ dataSetId })`; `null`
 * means "no hint, scan normally".
 *
 * `documentIdForDiagnostic` is optional — when supplied (e.g. by
 * the reconciler) it appears on the `filecoin.hint.malformed`
 * event so an operator can correlate the diagnostic with the
 * specific row. The value itself NEVER appears in the event.
 */
export function readFilecoinDataSetIdHint(
  hints: RawContentHints | undefined,
  documentIdForDiagnostic?: string,
): string | null {
  const sibling = readFilecoinSibling(hints);
  if (sibling === null) return null;
  return readPositiveBigintString(sibling['data_set_id'], 'data_set_id', documentIdForDiagnostic);
}

/**
 * Returns `{ dataSetId, pieceId }` from the sidecar — the bundle
 * `FilecoinRawContentStore.delete` consumes. `pieceId` is picked
 * from `filecoin.copies[]`:
 *
 *   1. Top-level `data_set_id` is validated first (positive
 *      decimal bigint or `null`).
 *   2. Each copy is read; only copies whose `data_set_id` is a
 *      valid positive decimal bigint AND whose `piece_id` is a
 *      valid positive decimal bigint are eligible.
 *   3. If the top-level `data_set_id` resolved (non-null), we
 *      prefer the first eligible copy whose `data_set_id`
 *      matches it. Otherwise the first eligible copy wins.
 *
 * Returns `{ dataSetId, pieceId }` where each field is the
 * validated string or `null`. Never throws. Malformed entries
 * emit one `filecoin.hint.malformed` diagnostic per offending
 * field (per copy) so the rejection is visible without leaking
 * the rejected value.
 */
export function readFilecoinDeleteHints(
  hints: RawContentHints | undefined,
  documentIdForDiagnostic?: string,
): FilecoinDeleteHints {
  const sibling = readFilecoinSibling(hints);
  if (sibling === null) return { dataSetId: null, pieceId: null };
  const dataSetId = readPositiveBigintString(
    sibling['data_set_id'],
    'data_set_id',
    documentIdForDiagnostic,
  );
  const pieceId = pickPieceIdFromCopies(sibling['copies'], dataSetId, documentIdForDiagnostic);
  return { dataSetId, pieceId };
}

function readFilecoinSibling(
  hints: RawContentHints | undefined,
): Record<string, unknown> | null {
  if (!hints || typeof hints !== 'object') return null;
  const sibling = (hints as Record<string, unknown>)['filecoin'];
  if (!sibling || typeof sibling !== 'object' || Array.isArray(sibling)) return null;
  return sibling as Record<string, unknown>;
}

function readPositiveBigintString(
  raw: unknown,
  fieldName: 'data_set_id' | 'piece_id',
  documentIdForDiagnostic: string | undefined,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    emitMalformed(`${fieldName}_not_a_string`, documentIdForDiagnostic);
    return null;
  }
  if (!POSITIVE_DECIMAL_BIGINT.test(raw)) {
    emitMalformed(`${fieldName}_not_positive_decimal_bigint`, documentIdForDiagnostic);
    return null;
  }
  return raw;
}

function pickPieceIdFromCopies(
  raw: unknown,
  preferredDataSetId: string | null,
  documentIdForDiagnostic: string | undefined,
): string | null {
  if (!Array.isArray(raw)) return null;
  let fallback: string | null = null;
  for (const entry of raw) {
    const pair = readCopyPair(entry, documentIdForDiagnostic);
    if (pair === null) continue;
    if (preferredDataSetId !== null && pair.dataSetId === preferredDataSetId) return pair.pieceId;
    if (fallback === null) fallback = pair.pieceId;
  }
  return fallback;
}

interface ValidatedCopyPair {
  readonly dataSetId: string;
  readonly pieceId: string;
}

function readCopyPair(
  entry: unknown,
  documentIdForDiagnostic: string | undefined,
): ValidatedCopyPair | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const copy = entry as Record<string, unknown>;
  const dataSetId = readPositiveBigintString(copy['data_set_id'], 'data_set_id', documentIdForDiagnostic);
  const pieceId = readPositiveBigintString(copy['piece_id'], 'piece_id', documentIdForDiagnostic);
  if (dataSetId === null || pieceId === null) return null;
  return { dataSetId, pieceId };
}

function emitMalformed(errorCode: string, documentIdForDiagnostic: string | undefined): void {
  emitFilecoinEvent('filecoin.hint.malformed', {
    provider: 'filecoin',
    errorCode,
    ...(documentIdForDiagnostic ? { documentId: documentIdForDiagnostic } : {}),
  });
}
