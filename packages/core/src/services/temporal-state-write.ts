/**
 * BEAM v38: write-time temporal-state pipeline (classifier + supersede).
 *
 * Two helpers split the path so `memory-storage.ts` can:
 *   1. classify BEFORE storing (so state_key / event_start land on the
 *      new memory row directly), and
 *   2. supersede AFTER storing (so the new row is excluded from the
 *      UPDATE via its own id).
 *
 * Failure modes:
 *   - LLM classifier throws: re-thrown. The ingest path decides whether
 *     to abort. We do NOT silently drop the signal.
 *   - LLM returns non_stateful: helper returns null; caller skips the
 *     supersede sweep and the row stores with NULL state_key.
 *   - Supersede UPDATE throws: re-thrown. Fail-closed.
 */

import type pg from 'pg';
import { classifyTemporalState, type TemporalStateClassification } from './temporal-classifier.js';
import { supersedePriorStateMemories } from '../db/repository-temporal-state.js';

/** Input bundle for the pre-store classifier call. */
export interface TemporalClassifyForWriteInput {
  /** User scope (used to namespace the state_key slug). */
  userId: string;
  /** Extracted fact text. */
  memoryText: string;
  /** Logical observed_at — used as event_start when the LLM does not. */
  observedAt: Date;
  /** Anthropic model ID for the classifier. */
  model: string;
}

/** Re-export so callers don't depend on the classifier module directly. */
export type { TemporalStateClassification };

/**
 * Classify a single memory's temporal state. Returns null when the
 * memory is non-stateful or the classifier rejects the model output.
 * Throws on transport / API failures so the caller fails closed.
 */
export async function classifyTemporalStateForWrite(
  input: TemporalClassifyForWriteInput,
): Promise<TemporalStateClassification | null> {
  return classifyTemporalState({
    memoryText: input.memoryText,
    observedAt: input.observedAt,
    userId: input.userId,
    model: input.model,
  });
}

/** Input bundle for the post-store supersede call. */
export interface SupersedeAfterStoreInput {
  /** Postgres pool — used for the UPDATE. */
  pool: pg.Pool;
  /** User scope. */
  userId: string;
  /** Stable state key chosen by the classifier. */
  stateKey: string;
  /** Newly stored memory's id (excluded from the UPDATE). */
  newMemoryId: string;
  /** New row's event_start, used as event_end for displaced rows. */
  eventStart: Date;
}

/**
 * UPDATE every prior, non-deleted memory with the same (user_id, state_key)
 * so it closes its `event_end` window at the new row's event_start.
 * Returns the count of rows touched. Re-throws on driver errors so the
 * ingest can fail closed.
 */
export async function supersedeAfterStore(
  input: SupersedeAfterStoreInput,
): Promise<number> {
  return supersedePriorStateMemories(input.pool, {
    userId: input.userId,
    stateKey: input.stateKey,
    newMemoryId: input.newMemoryId,
    eventEnd: input.eventStart,
  });
}
