/**
 * Unit tests for the rate limit retry utility.
 * Uses fake timers to avoid real delays and validates retry logic,
 * header extraction, and error propagation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryOnRateLimit } from '../api-retry.js';

function makeRateLimitError(headers: Record<string, string> = {}): Error {
  const err = new Error('Rate limit exceeded') as Error & { status: number; headers: Record<string, string> };
  err.status = 429;
  err.headers = headers;
  return err;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('retryOnRateLimit', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryOnRateLimit(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeRateLimitError())
      .mockResolvedValueOnce('recovered');

    const promise = retryOnRateLimit(fn);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws non-429 errors immediately without retry', async () => {
    const normalError = new Error('Connection refused');
    const fn = vi.fn().mockRejectedValue(normalError);

    await expect(retryOnRateLimit(fn)).rejects.toThrow('Connection refused');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('throws after exhausting all retries', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(makeRateLimitError({ 'retry-after-ms': '1' }));

    await expect(retryOnRateLimit(fn)).rejects.toThrow('Rate limit exceeded');
    expect(fn).toHaveBeenCalledTimes(5);
    vi.useFakeTimers();
  });

  it('uses retry-after-ms header when present', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeRateLimitError({ 'retry-after-ms': '5000' }))
      .mockResolvedValueOnce('ok');

    const promise = retryOnRateLimit(fn);

    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe('ok');
  });

  it('uses retry-after header (seconds) when retry-after-ms is absent', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeRateLimitError({ 'retry-after': '3' }))
      .mockResolvedValueOnce('ok');

    const promise = retryOnRateLimit(fn);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe('ok');
  });

  it('uses exponential backoff when no retry-after headers', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeRateLimitError())
      .mockRejectedValueOnce(makeRateLimitError())
      .mockResolvedValueOnce('ok');

    const promise = retryOnRateLimit(fn);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry errors without status property', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('Invalid argument'));

    await expect(retryOnRateLimit(fn)).rejects.toThrow('Invalid argument');
    expect(fn).toHaveBeenCalledOnce();
  });
});
