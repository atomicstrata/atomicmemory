/**
 * Unit tests for BeliefEdgesRepository — uses a mock pg.Pool to assert
 * SQL shape and result mapping without a live database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BeliefEdgesRepository, type BeliefEdgeType } from '../belief-edges-repository.js';
import { makeMockPool } from './mock-pool.js';

describe('BeliefEdgesRepository.appendEdge', () => {
  it('inserts evidence_for with positive weight and returns the id', async () => {
    const { pool, calls } = makeMockPool([[{ id: 'edge-1' }]]);
    const repo = new BeliefEdgesRepository(pool);
    const id = await repo.appendEdge({
      userId: 'u1',
      sourceId: 'src',
      targetId: 'tgt',
      edgeType: 'evidence_for',
      weight: 0.4,
      rationale: 'agreed twice',
    });
    expect(id).toBe('edge-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INSERT INTO belief_edges/);
    expect(calls[0].values).toEqual(['u1', 'src', 'tgt', 'evidence_for', 0.4, 'agreed twice', null, null]);
  });

  it('rejects evidence_for with negative weight (sign-mismatch)', async () => {
    const { pool } = makeMockPool([]);
    const repo = new BeliefEdgesRepository(pool);
    await expect(
      repo.appendEdge({
        userId: 'u1',
        sourceId: 's',
        targetId: 't',
        edgeType: 'evidence_for',
        weight: -0.3,
        rationale: 'bug',
      }),
    ).rejects.toThrow(/evidence_for edge weight must be >= 0/);
  });

  it('rejects counter with positive weight (sign-mismatch)', async () => {
    const { pool } = makeMockPool([]);
    const repo = new BeliefEdgesRepository(pool);
    await expect(
      repo.appendEdge({
        userId: 'u1',
        sourceId: 's',
        targetId: 't',
        edgeType: 'counter',
        weight: 0.2,
        rationale: 'bug',
      }),
    ).rejects.toThrow(/counter edge weight must be <= 0/);
  });

  it('rejects out-of-range weights for any edge type', async () => {
    const { pool } = makeMockPool([]);
    const repo = new BeliefEdgesRepository(pool);
    for (const edgeType of ['evidence_for', 'counter', 'supersedes', 'promotes', 'demotes'] as BeliefEdgeType[]) {
      await expect(
        repo.appendEdge({
          userId: 'u', sourceId: 's', targetId: 't',
          edgeType, weight: 2, rationale: '',
        }),
      ).rejects.toThrow(/weight must be in \[-1, 1\]/);
    }
  });

  it('inserts supersedes with arbitrary in-range weight', async () => {
    const { pool, calls } = makeMockPool([[{ id: 'edge-2' }]]);
    const repo = new BeliefEdgesRepository(pool);
    await repo.appendEdge({
      userId: 'u1', sourceId: 's', targetId: 't',
      edgeType: 'supersedes', weight: 1.0, rationale: 'replacement',
      workspaceId: 'ws-1', agentId: 'agent-7',
    });
    expect(calls[0].values).toEqual(['u1', 's', 't', 'supersedes', 1.0, 'replacement', 'ws-1', 'agent-7']);
  });
});

describe('BeliefEdgesRepository.getEdgesForTarget', () => {
  it('queries by user_id + target_id ordered by created_at DESC', async () => {
    const { pool, calls } = makeMockPool([[
      { id: 'e1', user_id: 'u', source_id: 's', target_id: 't', edge_type: 'evidence_for',
        weight: 0.3, rationale: 'x', created_at: new Date(), workspace_id: null, agent_id: null },
    ]]);
    const repo = new BeliefEdgesRepository(pool);
    const edges = await repo.getEdgesForTarget('u', 't');
    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe('evidence_for');
    expect(calls[0].text).toMatch(/WHERE user_id = \$1 AND target_id = \$2/);
    expect(calls[0].text).toMatch(/ORDER BY created_at DESC/);
  });
});

describe('BeliefEdgesRepository.aggregateConfidenceDelta', () => {
  it('returns zeros when no edges exist', async () => {
    const { pool } = makeMockPool([[]]);
    const repo = new BeliefEdgesRepository(pool);
    const agg = await repo.aggregateConfidenceDelta('u', 't');
    expect(agg).toEqual({
      evidenceForCount: 0,
      counterCount: 0,
      evidenceForWeightSum: 0,
      counterWeightSum: 0,
      netDelta: 0,
    });
  });

  it('aggregates evidence_for and counter weights into netDelta', async () => {
    const { pool } = makeMockPool([[
      { edge_type: 'evidence_for', n: '3', sum_weight: '0.6' },
      { edge_type: 'counter', n: '1', sum_weight: '-0.2' },
    ]]);
    const repo = new BeliefEdgesRepository(pool);
    const agg = await repo.aggregateConfidenceDelta('u', 't');
    expect(agg.evidenceForCount).toBe(3);
    expect(agg.counterCount).toBe(1);
    expect(agg.evidenceForWeightSum).toBeCloseTo(0.6);
    expect(agg.counterWeightSum).toBeCloseTo(-0.2);
    // netDelta = 0.6 - |-0.2| = 0.4
    expect(agg.netDelta).toBeCloseTo(0.4);
  });

  it('clamps netDelta to [-1, 1]', async () => {
    const { pool } = makeMockPool([[
      { edge_type: 'evidence_for', n: '10', sum_weight: '5.0' },
      { edge_type: 'counter', n: '0', sum_weight: null },
    ]]);
    const repo = new BeliefEdgesRepository(pool);
    const agg = await repo.aggregateConfidenceDelta('u', 't');
    expect(agg.netDelta).toBe(1);
  });

  it('treats null sum_weight as zero', async () => {
    const { pool } = makeMockPool([[
      { edge_type: 'evidence_for', n: '0', sum_weight: null },
    ]]);
    const repo = new BeliefEdgesRepository(pool);
    const agg = await repo.aggregateConfidenceDelta('u', 't');
    expect(agg.evidenceForWeightSum).toBe(0);
  });
});

describe('BeliefEdgesRepository.deleteAllForUser', () => {
  it('issues a user-scoped DELETE', async () => {
    const { pool, calls } = makeMockPool([[]]);
    const repo = new BeliefEdgesRepository(pool);
    await repo.deleteAllForUser('u-7');
    expect(calls[0].text).toMatch(/DELETE FROM belief_edges WHERE user_id = \$1/);
    expect(calls[0].values).toEqual(['u-7']);
  });
});
