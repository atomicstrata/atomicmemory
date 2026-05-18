/**
 * Backward-compatible wrapper around the split claim repository module.
 */

export { ClaimRepository } from './repository-claims.js';
export type {
  ClaimRow,
  ClaimVersionRow,
} from './repository-types.js';
export type {
  ClaimSlotInput,
  SlotBackfillCandidate,
  ClaimSlotTarget,
} from './repository-claims.js';
