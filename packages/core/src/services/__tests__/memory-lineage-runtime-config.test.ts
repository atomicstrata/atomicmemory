/**
 * Runtime config seam tests for memory-lineage.
 *
 * Verifies that ingest-side lineage emission uses the explicit runtime
 * llmModel when provided, instead of silently pinning actor_model to the
 * module singleton.
 */

import { describe, expect, it, vi } from 'vitest';

import { emitLineageEvent } from '../memory-lineage.js';

describe('memory-lineage runtime config seam', () => {
  it('uses the explicit llmModel for canonical add provenance', async () => {
    const claims = {
      createClaim: vi.fn().mockResolvedValue('claim-1'),
      createClaimVersion: vi.fn().mockResolvedValue('version-1'),
      setClaimCurrentVersion: vi.fn().mockResolvedValue(undefined),
      addEvidence: vi.fn().mockResolvedValue(undefined),
      createUpdateVersion: vi.fn(),
      supersedeClaimVersion: vi.fn(),
      invalidateClaim: vi.fn(),
    };
    const repo = {
      storeCanonicalMemoryObject: vi.fn().mockResolvedValue('cmo-1'),
    };

    await emitLineageEvent({ claims, repo, config: { llmModel: 'runtime-llm' } }, {
      kind: 'canonical-add',
      userId: 'user-1',
      fact: {
        fact: 'User prefers Rust.',
        headline: 'Prefers Rust',
        importance: 0.9,
        type: 'preference',
        keywords: ['rust'],
        entities: [],
        relations: [],
      },
      embedding: [0.1, 0.2],
      sourceSite: 'chat',
      sourceUrl: 'https://source/test',
      episodeId: 'episode-1',
      logicalTimestamp: undefined,
      claimSlot: null,
      createProjection: vi.fn().mockResolvedValue('memory-1'),
    });

    expect(claims.createClaimVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({ actorModel: 'runtime-llm' }),
      }),
    );
  });
});
