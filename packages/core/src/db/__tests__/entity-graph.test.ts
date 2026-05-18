/**
 * Integration tests for entity graph repository (Phase 5).
 * Tests entity resolution (dedup by embedding+type), memory-entity linking,
 * and entity-aware memory retrieval.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestSchema, unitVector, offsetVector } from './test-fixtures.js';
import { pool } from '../pool.js';
import { EntityRepository } from '../repository-entities.js';
import { MemoryRepository } from '../memory-repository.js';

const TEST_USER = 'entity-graph-test-user';

describe('entity graph repository', () => {
  const entityRepo = new EntityRepository(pool);
  const memoryRepo = new MemoryRepository(pool);

  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await entityRepo.deleteAll();
    await memoryRepo.deleteAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a new entity and retrieves it', async () => {
    const embedding = unitVector(11);
    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'PostgreSQL',
      entityType: 'tool',
      embedding,
    });

    expect(entityId).toBeTruthy();
    const entity = await entityRepo.getEntity(entityId);
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe('PostgreSQL');
    expect(entity!.entity_type).toBe('tool');
  });

  it('resolves duplicate entities by embedding similarity', async () => {
    const embedding1 = unitVector(21);
    const embedding2 = offsetVector(embedding1, 7, 0.001);

    const id1 = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'PostgreSQL',
      entityType: 'tool',
      embedding: embedding1,
    });

    const id2 = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Postgres',
      entityType: 'tool',
      embedding: embedding2,
    });

    expect(id2).toBe(id1);
    const count = await entityRepo.countEntities(TEST_USER);
    expect(count).toBe(1);

    const entity = await entityRepo.getEntity(id1);
    expect(entity!.alias_names).toContain('Postgres');
  });

  it('creates separate entities for different types even with similar embeddings', async () => {
    const embedding = unitVector(31);

    const toolId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Go',
      entityType: 'tool',
      embedding,
    });

    const conceptId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Go',
      entityType: 'concept',
      embedding,
    });

    expect(toolId).not.toBe(conceptId);
    expect(await entityRepo.countEntities(TEST_USER)).toBe(2);
  });

  it('creates separate entities when similarity is below threshold', async () => {
    const embedding1 = unitVector(41);
    const embedding2 = unitVector(42);

    const id1 = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'React',
      entityType: 'tool',
      embedding: embedding1,
    });

    const id2 = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Vue',
      entityType: 'tool',
      embedding: embedding2,
    });

    expect(id1).not.toBe(id2);
  });

  it('links memories to entities and retrieves by entity', async () => {
    const entityEmbed = unitVector(51);
    const memEmbed = unitVector(52);

    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Jake',
      entityType: 'person',
      embedding: entityEmbed,
    });

    const memoryId = await memoryRepo.storeMemory({
      userId: TEST_USER,
      content: 'Jake prefers dark mode',
      embedding: memEmbed,
      importance: 0.7,
      sourceSite: 'test',
    });

    await entityRepo.linkMemoryToEntity(memoryId, entityId);

    const entities = await entityRepo.getEntitiesForMemory(memoryId);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe('Jake');

    const memoryIds = await entityRepo.findMemoryIdsByEntities(
      TEST_USER, [entityId], new Set(), 10,
    );
    expect(memoryIds).toContain(memoryId);
  });

  it('does not return soft-deleted memories from entity expansion', async () => {
    const entityEmbed = unitVector(61);
    const memEmbed = unitVector(62);

    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Redis',
      entityType: 'tool',
      embedding: entityEmbed,
    });

    const memoryId = await memoryRepo.storeMemory({
      userId: TEST_USER,
      content: 'User uses Redis for caching',
      embedding: memEmbed,
      importance: 0.6,
      sourceSite: 'test',
    });

    await entityRepo.linkMemoryToEntity(memoryId, entityId);
    await memoryRepo.softDeleteMemory(TEST_USER, memoryId);

    const memoryIds = await entityRepo.findMemoryIdsByEntities(
      TEST_USER, [entityId], new Set(), 10,
    );
    expect(memoryIds).toHaveLength(0);
  });

  it('searches entities by query embedding', async () => {
    const embedding = unitVector(71);
    await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'TypeScript',
      entityType: 'tool',
      embedding,
    });

    const query = offsetVector(embedding, 13, 0.002);
    const results = await entityRepo.searchEntities(TEST_USER, query, 5, 0.5);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('TypeScript');
    expect(results[0].similarity).toBeGreaterThan(0.9);
  });

  it('respects exclude set in findMemoryIdsByEntities', async () => {
    const entityEmbed = unitVector(81);

    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Docker',
      entityType: 'tool',
      embedding: entityEmbed,
    });

    const mem1 = await memoryRepo.storeMemory({
      userId: TEST_USER,
      content: 'User runs Docker in production',
      embedding: unitVector(82),
      importance: 0.6,
      sourceSite: 'test',
    });

    const mem2 = await memoryRepo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Docker Compose',
      embedding: unitVector(83),
      importance: 0.5,
      sourceSite: 'test',
    });

    await entityRepo.linkMemoryToEntity(mem1, entityId);
    await entityRepo.linkMemoryToEntity(mem2, entityId);

    const excluded = new Set([mem1]);
    const memoryIds = await entityRepo.findMemoryIdsByEntities(
      TEST_USER, [entityId], excluded, 10,
    );
    expect(memoryIds).toHaveLength(1);
    expect(memoryIds[0]).toBe(mem2);
  });

  it('mergeAlias is idempotent for existing aliases', async () => {
    const embedding = unitVector(91);
    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'PostgreSQL',
      entityType: 'tool',
      embedding,
    });

    await entityRepo.mergeAlias(pool as any, entityId, 'Postgres');
    await entityRepo.mergeAlias(pool as any, entityId, 'Postgres');

    const entity = await entityRepo.getEntity(entityId);
    expect(entity!.alias_names.filter((a) => a === 'Postgres')).toHaveLength(1);
  });

  it('resolves normalized exact-name matches before embedding similarity', async () => {
    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Node.js',
      entityType: 'tool',
      embedding: unitVector(92),
    });

    const resolvedId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'node js',
      entityType: 'tool',
      embedding: unitVector(193),
    });

    expect(resolvedId).toBe(entityId);
    const entity = await entityRepo.getEntity(entityId);
    expect(entity?.normalized_name).toBe('node js');
    expect(entity?.alias_names).toContain('node js');
    expect(entity?.normalized_alias_names).toHaveLength(0);
  });

  it('finds entities by normalized alias names', async () => {
    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Node JS',
      entityType: 'tool',
      embedding: unitVector(94),
    });
    await entityRepo.mergeAlias(pool as any, entityId, 'Node.js');
    const matches = await entityRepo.findEntitiesByName(TEST_USER, 'node.js');

    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(entityId);
  });

  it('does not merge alias when it matches the entity name', async () => {
    const embedding = unitVector(95);
    const entityId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'React',
      entityType: 'tool',
      embedding,
    });

    await entityRepo.mergeAlias(pool as any, entityId, 'React');

    const entity = await entityRepo.getEntity(entityId);
    expect(entity!.alias_names).toHaveLength(0);
  });

  describe('entity relations', () => {
    it('creates and retrieves a relation between entities', async () => {
      const personId = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Jake', entityType: 'person', embedding: unitVector(101),
      });
      const toolId = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'PostgreSQL', entityType: 'tool', embedding: unitVector(102),
      });

      const relationId = await entityRepo.upsertRelation({
        userId: TEST_USER,
        sourceEntityId: personId,
        targetEntityId: toolId,
        relationType: 'uses',
      });

      expect(relationId).toBeTruthy();
      const relations = await entityRepo.getRelationsForEntity(personId);
      expect(relations).toHaveLength(1);
      expect(relations[0].relation_type).toBe('uses');
      expect(relations[0].target_entity_id).toBe(toolId);
    });

    it('upserts relations with higher confidence', async () => {
      const e1 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Alice', entityType: 'person', embedding: unitVector(111),
      });
      const e2 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'ProjectX', entityType: 'project', embedding: unitVector(112),
      });

      await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: e1, targetEntityId: e2,
        relationType: 'works_on', confidence: 0.5,
      });
      await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: e1, targetEntityId: e2,
        relationType: 'works_on', confidence: 0.9,
      });

      const relations = await entityRepo.getRelationsForEntity(e1);
      expect(relations).toHaveLength(1);
      expect(relations[0].confidence).toBeCloseTo(0.9);
    });

    it('updates relation source_memory_id to the latest supporting memory', async () => {
      const personId = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Jake', entityType: 'person', embedding: unitVector(113),
      });
      const orgId = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'OpenAI', entityType: 'organization', embedding: unitVector(114),
      });
      const firstMemoryId = await memoryRepo.storeMemory({
        userId: TEST_USER,
        content: 'Jake works at OpenAI',
        embedding: unitVector(115),
        importance: 0.6,
        sourceSite: 'test',
      });
      const secondMemoryId = await memoryRepo.storeMemory({
        userId: TEST_USER,
        content: 'Jake still works at OpenAI',
        embedding: unitVector(116),
        importance: 0.6,
        sourceSite: 'test',
      });

      await entityRepo.upsertRelation({
        userId: TEST_USER,
        sourceEntityId: personId,
        targetEntityId: orgId,
        relationType: 'works_at',
        sourceMemoryId: firstMemoryId,
      });
      await entityRepo.upsertRelation({
        userId: TEST_USER,
        sourceEntityId: personId,
        targetEntityId: orgId,
        relationType: 'works_at',
        sourceMemoryId: secondMemoryId,
      });

      const relations = await entityRepo.getRelationsForEntity(personId);
      expect(relations).toHaveLength(1);
      expect(relations[0].source_memory_id).toBe(secondMemoryId);
    });

    it('finds related entities via 1-hop traversal', async () => {
      const person = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Bob', entityType: 'person', embedding: unitVector(121),
      });
      const tool = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Rust', entityType: 'tool', embedding: unitVector(122),
      });
      const project = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'dotctl', entityType: 'project', embedding: unitVector(123),
      });

      await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: person, targetEntityId: tool, relationType: 'uses',
      });
      await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: person, targetEntityId: project, relationType: 'works_on',
      });

      const related = await entityRepo.findRelatedEntityIds(TEST_USER, [person], new Set(), 10);
      expect(related).toHaveLength(2);
      expect(related).toContain(tool);
      expect(related).toContain(project);
    });

    it('traverses relations in both directions', async () => {
      const e1 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'MIT', entityType: 'organization', embedding: unitVector(131),
      });
      const e2 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Cambridge', entityType: 'place', embedding: unitVector(132),
      });

      await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: e1, targetEntityId: e2, relationType: 'located_in',
      });

      const fromTarget = await entityRepo.findRelatedEntityIds(TEST_USER, [e2], new Set(), 10);
      expect(fromTarget).toContain(e1);
    });

    it('invalidates a relation by setting valid_to', async () => {
      const e1 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Charlie', entityType: 'person', embedding: unitVector(141),
      });
      const e2 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'OldCorp', entityType: 'organization', embedding: unitVector(142),
      });

      const relationId = await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: e1, targetEntityId: e2, relationType: 'works_at',
      });

      await entityRepo.invalidateRelation(relationId);

      const relations = await entityRepo.getRelationsForEntity(e1);
      expect(relations).toHaveLength(0);

      const related = await entityRepo.findRelatedEntityIds(TEST_USER, [e1], new Set(), 10);
      expect(related).toHaveLength(0);
    });

    it('finds memory relations through linked entities even if another memory created the relation first', async () => {
      const personId = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Jake', entityType: 'person', embedding: unitVector(145),
      });
      const orgId = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'OpenAI', entityType: 'organization', embedding: unitVector(146),
      });
      const firstMemoryId = await memoryRepo.storeMemory({
        userId: TEST_USER,
        content: 'Jake works at OpenAI',
        embedding: unitVector(147),
        importance: 0.6,
        sourceSite: 'test',
      });
      const secondMemoryId = await memoryRepo.storeMemory({
        userId: TEST_USER,
        content: 'OpenAI is still Jake\'s employer',
        embedding: unitVector(148),
        importance: 0.6,
        sourceSite: 'test',
      });

      await entityRepo.linkMemoryToEntity(firstMemoryId, personId);
      await entityRepo.linkMemoryToEntity(firstMemoryId, orgId);
      await entityRepo.linkMemoryToEntity(secondMemoryId, personId);
      await entityRepo.linkMemoryToEntity(secondMemoryId, orgId);
      await entityRepo.upsertRelation({
        userId: TEST_USER,
        sourceEntityId: personId,
        targetEntityId: orgId,
        relationType: 'works_at',
        sourceMemoryId: firstMemoryId,
      });

      const relations = await entityRepo.getRelationsForMemory(TEST_USER, secondMemoryId);
      expect(relations).toHaveLength(1);
      expect(relations[0].relation_type).toBe('works_at');
      expect(relations[0].source_entity_id).toBe(personId);
      expect(relations[0].target_entity_id).toBe(orgId);
    });

    it('counts active relations for a user', async () => {
      const e1 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Dave', entityType: 'person', embedding: unitVector(151),
      });
      const e2 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'Python', entityType: 'tool', embedding: unitVector(152),
      });
      const e3 = await entityRepo.resolveEntity({
        userId: TEST_USER, name: 'FastAPI', entityType: 'tool', embedding: unitVector(153),
      });

      await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: e1, targetEntityId: e2, relationType: 'uses',
      });
      await entityRepo.upsertRelation({
        userId: TEST_USER, sourceEntityId: e1, targetEntityId: e3, relationType: 'uses',
      });

      expect(await entityRepo.countRelations(TEST_USER)).toBe(2);
    });

    it('does not return leaked memories from another user even if linked to the same entity', async () => {
      const entityId = await entityRepo.resolveEntity({
        userId: TEST_USER,
        name: 'Shared Tool',
        entityType: 'tool',
        embedding: unitVector(161),
      });

      const foreignMemoryId = await memoryRepo.storeMemory({
        userId: 'other-user',
        content: 'Foreign tenant memory',
        embedding: unitVector(162),
        importance: 0.4,
        sourceSite: 'test',
      });

      await entityRepo.linkMemoryToEntity(foreignMemoryId, entityId);

      const memoryIds = await entityRepo.findMemoryIdsByEntities(
        TEST_USER,
        [entityId],
        new Set(),
        10,
      );
      expect(memoryIds).not.toContain(foreignMemoryId);
    });
  });
});

// unitVector and offsetVector imported from test-fixtures.ts
