/**
 * Unit tests for Cloud JWT user binding helpers.
 */

import { describe, expect, it } from 'vitest';
import { resolveReconcileUserId } from '../cloud-jwt-user-binding.js';

describe('resolveReconcileUserId', () => {
  it('uses body user_id when present', () => {
    expect(resolveReconcileUserId('bob', 'alice')).toBe('bob');
  });

  it('defaults to asserted JWT user when body user_id is absent', () => {
    expect(resolveReconcileUserId(undefined, 'alice')).toBe('alice');
  });

  it('returns undefined for static-key callers with no body user_id', () => {
    expect(resolveReconcileUserId(undefined, null)).toBeUndefined();
  });
});
