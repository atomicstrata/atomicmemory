/**
 * Unit tests for Cloud trace sync auth pause recovery.
 */

import { describe, expect, it } from 'vitest';
import { resetCloudTraceAuthPause } from '../cloud-trace-sync.js';

describe('resetCloudTraceAuthPause', () => {
  it('clears paused and auth-related lastErrorCode', () => {
    const state = { paused: true, lastErrorCode: 'auth_401' };
    resetCloudTraceAuthPause(state);
    expect(state.paused).toBe(false);
    expect(state.lastErrorCode).toBeNull();
  });

  it('clears non-auth lastErrorCode after a successful upload', () => {
    const state = { paused: true, lastErrorCode: 'network_error' };
    resetCloudTraceAuthPause(state);
    expect(state.paused).toBe(false);
    expect(state.lastErrorCode).toBeNull();
  });
});
