/**
 * Runtime config seam tests for memory-storage.
 *
 * Verifies that namespace classification decisions come from the explicit
 * runtime config passed through MemoryService deps, not the module singleton.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../namespace-retrieval.js', () => ({
  classifyNamespace: vi.fn(),
  inferNamespace: vi.fn(),
}));

import { config } from '../../config.js';
import { storeProjection } from '../memory-storage.js';
import { classifyNamespace, inferNamespace } from '../namespace-retrieval.js';

function makeStorageDeps(): any {
  const memory = { storeMemory: vi.fn().mockResolvedValue('memory-1') };
  const representation = { storeAtomicFacts: vi.fn().mockResolvedValue(undefined), storeForesight: vi.fn().mockResolvedValue(undefined) };
  return {
    config: { namespaceClassificationEnabled: true, auditLoggingEnabled: false },
    repo: { ...memory, ...representation },
    stores: { memory, representation, claim: {}, entity: null, lesson: null, search: {}, link: {}, episode: {} },
  };
}

describe('memory-storage runtime config seam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses deps.config.namespaceClassificationEnabled instead of the singleton flag', async () => {
    const originalNamespaceClassificationEnabled = config.namespaceClassificationEnabled;
    config.namespaceClassificationEnabled = false;

    vi.mocked(classifyNamespace).mockResolvedValue('runtime.namespace');
    vi.mocked(inferNamespace).mockReturnValue('singleton.namespace');

    const deps = makeStorageDeps();

    try {
      await storeProjection(
        deps,
        'user-1',
        {
          fact: 'User prefers PostgreSQL.',
          headline: 'Prefers PostgreSQL',
          importance: 0.8,
          type: 'knowledge',
          keywords: ['postgresql'],
          entities: [],
          relations: [],
        },
        [0.1, 0.2],
        'chat.openai.com',
        'https://chat.example/test',
        'episode-1',
        0.95,
      );
    } finally {
      config.namespaceClassificationEnabled = originalNamespaceClassificationEnabled;
    }

    expect(classifyNamespace).toHaveBeenCalledWith(
      'User prefers PostgreSQL.',
      'chat.openai.com',
      ['postgresql'],
    );
    expect(inferNamespace).not.toHaveBeenCalled();
    expect(deps.repo.storeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'runtime.namespace' }),
    );
  });

  it('passes logical session timestamps to stored memory dates', async () => {
    vi.mocked(classifyNamespace).mockResolvedValue('runtime.namespace');
    const deps = makeStorageDeps();
    const logicalTimestamp = new Date('2023-08-15T16:20:00.000Z');

    await storeProjection(deps, 'user-1', {
      fact: 'Sam had a doctor appointment.',
      headline: 'Doctor appointment',
      importance: 0.8,
      type: 'knowledge',
      keywords: ['doctor'],
      entities: [],
      relations: [],
    }, [0.1, 0.2], 'atomicbench', '2023-08-15T16:20:00.000Z', 'episode-1', 0.95, {
      logicalTimestamp,
    });

    expect(deps.repo.storeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: logicalTimestamp, observedAt: logicalTimestamp }),
    );
  });
});
