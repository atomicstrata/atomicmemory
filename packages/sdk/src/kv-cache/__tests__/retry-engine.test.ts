/**
 * @file RetryEngine unit tests
 *
 * Covers the retry loop, backoff math, abort-signal propagation, timeout
 * failure, and the retryable-error classifier. Integration-level retry
 * coverage still lives in tests/integration/storage/storage-manager-retry
 * — these tests pin the extracted module's contract directly so future
 * changes inside storage-manager.ts cannot silently break it.
 */

import { describe, it, expect, vi } from 'vitest';
import { RetryEngine, type RetryEngineConfig } from '../retry-engine';
import { EventEmitter } from '../../core/events';
import { StorageError } from '../../core/error-handling/errors';
import { getLogger } from '../../utils/logger';

function createEngine(overrides: Partial<RetryEngineConfig['retryPolicy']> = {}) {
  const config: RetryEngineConfig = {
    retryPolicy: {
      maxAttempts: 3,
      initialDelay: 1,
      maxDelay: 5,
      backoffMultiplier: 2,
      jitterFactor: 0,
      ...overrides,
    },
    collectErrors: true,
  };
  const emitter = new EventEmitter();
  const engine = new RetryEngine(config, emitter, getLogger('test'));
  return { engine, emitter };
}

describe('RetryEngine.executeWithRetry', () => {
  it('returns the value on first success', async () => {
    const { engine } = createEngine();
    const op = vi.fn(async () => 'ok');

    const result = await engine.executeWithRetry(op, { operationName: 'get' });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable StorageError and emits retry/success events', async () => {
    const { engine, emitter } = createEngine();
    const attempts: string[] = [];
    emitter.on('storageRetryAttempt', () => attempts.push('attempt'));
    emitter.on('storageRetrySuccess', () => attempts.push('success'));

    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 2) {
        throw new StorageError('temporary', 'TEMPORARY', {}, true);
      }
      return 'ok';
    });

    const result = await engine.executeWithRetry(op, { operationName: 'get', key: 'k' });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(['attempt', 'success']);
  });

  it('does not retry a non-retryable StorageError', async () => {
    const { engine } = createEngine();
    const op = vi.fn(async () => {
      throw new StorageError('bad key', 'INVALID', {}, false);
    });

    await expect(
      engine.executeWithRetry(op, { operationName: 'get', key: 'k' }),
    ).rejects.toThrow('bad key');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries plain errors matching network/timeout patterns', async () => {
    const { engine } = createEngine();
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNRESET connection dropped');
      return 'ok';
    });

    const result = await engine.executeWithRetry(op, { operationName: 'set' });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts and throws last error', async () => {
    const { engine } = createEngine({ maxAttempts: 2 });
    const op = vi.fn(async () => {
      throw new StorageError('timeout', 'TIMEOUT', {}, true);
    });

    await expect(engine.executeWithRetry(op, { operationName: 'get' })).rejects.toThrow('timeout');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('aborts immediately when signal is already aborted', async () => {
    const { engine } = createEngine();
    const signal = AbortSignal.abort();
    const op = vi.fn(async () => 'ok');

    await expect(
      engine.executeWithRetry(op, { operationName: 'get', signal }),
    ).rejects.toThrow('Operation aborted before starting');
    expect(op).not.toHaveBeenCalled();
  });

  it('throws maxTotalDuration error when elapsed exceeds limit', async () => {
    vi.useFakeTimers();
    try {
      // initialDelay=50 so the first retry's delayWithAbort window is long
      // enough that vi.advanceTimersByTime advances Date.now() past the
      // maxTotalDuration=10ms budget before the pre-attempt duration check
      // on attempt 2 runs.
      const { engine } = createEngine({
        maxAttempts: 5,
        maxTotalDuration: 10,
        initialDelay: 50,
        maxDelay: 50,
      });

      let calls = 0;
      const op = vi.fn(async () => {
        calls++;
        throw new StorageError('still failing', 'TEMPORARY', {}, true);
      });

      const promise = engine.executeWithRetry(op, { operationName: 'get' });
      const assertion = expect(promise).rejects.toThrow(/exceeded maximum total duration/);

      // Drain the retry loop deterministically: advance past the first
      // delayWithAbort sleep so the second attempt's checkTotalDuration
      // sees the clock at 50ms, well past the 10ms budget.
      await vi.advanceTimersByTimeAsync(100);

      await assertion;
      expect(calls).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits storageError with finalAttempt=true on terminal failure', async () => {
    const { engine, emitter } = createEngine({ maxAttempts: 1 });
    const events: Array<{ finalAttempt: boolean }> = [];
    emitter.on('storageError', (payload: any) => events.push(payload));

    const op = async () => {
      throw new StorageError('nope', 'INVALID', {}, false);
    };

    await expect(engine.executeWithRetry(op, { operationName: 'get' })).rejects.toThrow();
    expect(events.length).toBe(1);
    expect(events[0].finalAttempt).toBe(true);
  });

  it('suppresses storageError events when collectErrors is false', async () => {
    const config: RetryEngineConfig = {
      retryPolicy: { maxAttempts: 1, initialDelay: 1, maxDelay: 1, backoffMultiplier: 2, jitterFactor: 0 },
      collectErrors: false,
    };
    const emitter = new EventEmitter();
    const engine = new RetryEngine(config, emitter, getLogger('test'));
    const events: unknown[] = [];
    emitter.on('storageError', (e: unknown) => events.push(e));

    const op = async () => {
      throw new StorageError('nope', 'INVALID', {}, false);
    };

    await expect(engine.executeWithRetry(op, { operationName: 'get' })).rejects.toThrow();
    expect(events).toEqual([]);
  });
});

describe('RetryEngine.withTimeout', () => {
  it('resolves when operation finishes before the timeout', async () => {
    const { engine } = createEngine();
    // Operation resolves synchronously (next microtask) — no real sleeping.
    const result = await engine.withTimeout(async () => 'done', 50);
    expect(result).toBe('done');
  });

  it('rejects with a retryable TIMEOUT StorageError when the operation exceeds the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { engine } = createEngine();
      const slow = () => new Promise<string>(resolve => setTimeout(() => resolve('late'), 100));
      const errorPromise = engine.withTimeout(slow, 10).catch(e => e);

      // Advance just past the 10ms deadline — withTimeout's setTimeout
      // fires first and rejects with STORAGE_TIMEOUT before the 100ms
      // operation can resolve.
      await vi.advanceTimersByTimeAsync(15);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe('STORAGE_TIMEOUT');
      expect((error as StorageError).retryable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
