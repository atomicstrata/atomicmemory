/**
 * Unit tests for zero-LLM query augmentation via entity graph matching.
 * Tests augmentQueryWithEntities() which matches query embeddings against
 * entities and appends their names to the query text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityRepository } from '../../db/repository-entities.js';

const mockConfig = {
  queryAugmentationEnabled: true,
  queryAugmentationMaxEntities: 5,
  queryAugmentationMinSimilarity: 0.4,
  queryExpansionMinSimilarity: 0.5,
};

vi.mock('../../config.js', () => ({ config: mockConfig }));
vi.mock('../llm.js', () => ({ llm: { chat: vi.fn() } }));
vi.mock('../embedding.js', () => ({ embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) }));

const { augmentQueryWithEntities } = await import('../query-expansion.js');

function createMockEntityRepo(
  entities: Array<{ name: string; entity_type: string; similarity: number }>,
) {
  return {
    searchEntities: vi.fn().mockResolvedValue(
      entities.map((e, i) => ({
        id: `entity-${i}`,
        user_id: 'user-1',
        name: e.name,
        entity_type: e.entity_type,
        embedding: [0.1],
        alias_names: [],
        created_at: new Date(),
        updated_at: new Date(),
        similarity: e.similarity,
      })),
    ),
  } as unknown as EntityRepository;
}

describe('augmentQueryWithEntities', () => {
  beforeEach(() => {
    mockConfig.queryAugmentationMaxEntities = 5;
    mockConfig.queryAugmentationMinSimilarity = 0.4;
  });

  it('appends matched entity names to query', async () => {
    const entityRepo = createMockEntityRepo([
      { name: 'Python', entity_type: 'tool', similarity: 0.72 },
      { name: 'FastAPI', entity_type: 'tool', similarity: 0.65 },
    ]);

    const result = await augmentQueryWithEntities(
      entityRepo, 'user-1', 'How should I implement caching?', [0.1, 0.2],
    );

    expect(result.augmentedQuery).toBe(
      'How should I implement caching? [context: Python, FastAPI]',
    );
    expect(result.originalQuery).toBe('How should I implement caching?');
    expect(result.matchedEntities).toHaveLength(2);
  });

  it('returns original query when no entities match', async () => {
    const entityRepo = createMockEntityRepo([]);

    const result = await augmentQueryWithEntities(
      entityRepo, 'user-1', 'random query', [0.1, 0.2],
    );

    expect(result.augmentedQuery).toBe('random query');
    expect(result.matchedEntities).toHaveLength(0);
  });

  it('passes config thresholds to entity search', async () => {
    mockConfig.queryAugmentationMaxEntities = 3;
    mockConfig.queryAugmentationMinSimilarity = 0.6;

    const entityRepo = createMockEntityRepo([]);

    await augmentQueryWithEntities(
      entityRepo, 'user-1', 'test query', [0.5, 0.5],
    );

    expect(entityRepo.searchEntities).toHaveBeenCalledWith(
      'user-1', [0.5, 0.5], 3, 0.6,
    );
  });

  it('prefers explicit runtime config over module config thresholds', async () => {
    mockConfig.queryAugmentationMaxEntities = 1;
    mockConfig.queryAugmentationMinSimilarity = 0.95;
    const entityRepo = createMockEntityRepo([]);

    await augmentQueryWithEntities(
      entityRepo,
      'user-1',
      'override query',
      [0.4, 0.4],
      {
        queryExpansionMinSimilarity: 0.5,
        queryAugmentationMaxEntities: 4,
        queryAugmentationMinSimilarity: 0.25,
      },
    );

    expect(entityRepo.searchEntities).toHaveBeenCalledWith(
      'user-1', [0.4, 0.4], 4, 0.25,
    );
  });

  it('includes entity type and similarity in metadata', async () => {
    const entityRepo = createMockEntityRepo([
      { name: 'Redis', entity_type: 'tool', similarity: 0.85 },
    ]);

    const result = await augmentQueryWithEntities(
      entityRepo, 'user-1', 'caching strategy', [0.1, 0.2],
    );

    expect(result.matchedEntities[0]).toEqual({
      name: 'Redis',
      entityType: 'tool',
      similarity: 0.85,
    });
  });

  it('handles single entity match', async () => {
    const entityRepo = createMockEntityRepo([
      { name: 'PostgreSQL', entity_type: 'tool', similarity: 0.9 },
    ]);

    const result = await augmentQueryWithEntities(
      entityRepo, 'user-1', 'database query optimization', [0.1, 0.2],
    );

    expect(result.augmentedQuery).toBe(
      'database query optimization [context: PostgreSQL]',
    );
  });

  it('preserves entity order from search results', async () => {
    const entityRepo = createMockEntityRepo([
      { name: 'TypeScript', entity_type: 'tool', similarity: 0.8 },
      { name: 'React', entity_type: 'tool', similarity: 0.7 },
      { name: 'Vite', entity_type: 'tool', similarity: 0.5 },
    ]);

    const result = await augmentQueryWithEntities(
      entityRepo, 'user-1', 'frontend build setup', [0.1, 0.2],
    );

    expect(result.augmentedQuery).toBe(
      'frontend build setup [context: TypeScript, React, Vite]',
    );
  });
});
