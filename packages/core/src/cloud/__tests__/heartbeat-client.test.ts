/**
 * Heartbeat client unit tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRuntimeHeartbeat } from '../heartbeat-client.js';

describe('sendRuntimeHeartbeat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    const result = await sendRuntimeHeartbeat({
      apiUrl: 'https://api.test',
      apiKey: 'amc_test_key',
      payload: {
        core_instance_id: 'inst-1',
        core_version: '1.0.0',
        connector_version: '1.0.0',
        capabilities: ['memory.read'],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it('maps auth failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const result = await sendRuntimeHeartbeat({
      apiUrl: 'https://api.test',
      apiKey: 'amc_test_key',
      payload: {
        core_instance_id: 'inst-1',
        core_version: '1.0.0',
        connector_version: '1.0.0',
        capabilities: [],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('auth_401');
  });
});
