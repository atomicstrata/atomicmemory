/**
 * @file Hindsight Provider Live Integration Tests
 *
 * Opt-in tests for a running Hindsight API. Set `HINDSIGHT_TEST_API_URL`, for
 * example `http://localhost:8890`, after starting the local Docker backend.
 * These tests exercise the real provider HTTP path and are skipped by default
 * so normal unit test runs do not require external services or LLM credentials.
 */

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HindsightProvider } from '../hindsight-provider';
import type { Scope } from '../../types';
import type {
  HindsightOperationsHandle,
  HindsightRetainHandle,
  HindsightRetainResponse,
} from '../types';

const apiUrl = process.env.HINDSIGHT_TEST_API_URL;
const runLive = apiUrl ? describe : describe.skip;
const COMPLETED_OPERATION_STATUS = 'completed';
const FAILED_OPERATION_STATUSES = new Set(['cancelled', 'failed']);
const OPERATION_STATUS_ATTEMPTS = 30;

runLive('hindsight live integration', () => {
  it('retains, searches, and reflects against a running Hindsight API', async () => {
    const provider = new HindsightProvider({
      apiUrl: requireApiUrl(),
      defaultMaxTokens: 4_096,
      timeout: 120_000,
    });
    const scope = uniqueScope();
    const retain =
      provider.getExtension<HindsightRetainHandle>('hindsight.retain');

    expect(retain).toBeDefined();
    if (!retain) throw new Error('hindsight.retain extension is missing');

    const retained = await retain.retain({
      mode: 'text',
      content:
        'Alice validates AtomicMemory Hindsight provider integration in Docker.',
      scope,
    });
    await waitForRetainOperations(provider, scope, retained);

    const search = await provider.search({
      query: 'Alice validates AtomicMemory Hindsight provider integration',
      scope,
      limit: 3,
    });
    const insights = await provider.reflect(
      'What does Alice validate?',
      scope,
    );

    expect(retained.success).toBe(true);
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0].memory.metadata?.tags).toContain('agent:sdk');
    expect(insights[0].content).toContain('AtomicMemory');
  }, 180_000);
});

async function waitForRetainOperations(
  provider: HindsightProvider,
  scope: Scope,
  retained: HindsightRetainResponse,
): Promise<void> {
  const operationIds = retainOperationIds(retained);
  if (operationIds.length === 0) return;

  const operations = provider.getExtension<HindsightOperationsHandle>(
    'hindsight.operations',
  );
  expect(operations).toBeDefined();
  if (!operations) throw new Error('hindsight.operations extension is missing');

  for (const operationId of operationIds) {
    await waitForOperation(operations, scope, operationId);
  }
}

async function waitForOperation(
  operations: HindsightOperationsHandle,
  scope: Scope,
  operationId: string,
): Promise<void> {
  let lastStatus = 'missing';
  for (let attempt = 0; attempt < OPERATION_STATUS_ATTEMPTS; attempt += 1) {
    const operation = await operations.get(scope, operationId);
    lastStatus = operation?.status ?? 'missing';
    if (lastStatus === COMPLETED_OPERATION_STATUS) return;
    if (FAILED_OPERATION_STATUSES.has(lastStatus)) {
      throw new Error(`Hindsight operation ${operationId} ${lastStatus}`);
    }
  }
  throw new Error(
    `Hindsight operation ${operationId} did not complete: ${lastStatus}`,
  );
}

function retainOperationIds(retained: HindsightRetainResponse): string[] {
  return [
    retained.operation_id,
    ...(retained.operation_ids ?? []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function requireApiUrl(): string {
  if (!apiUrl) throw new Error('HINDSIGHT_TEST_API_URL is required');
  return apiUrl;
}

function uniqueScope(): Scope {
  return {
    user: `atomicmemory-live-${randomUUID()}`,
    agent: 'sdk',
  };
}
