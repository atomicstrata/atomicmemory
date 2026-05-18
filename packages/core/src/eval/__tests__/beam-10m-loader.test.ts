/**
 * Unit tests for the BEAM-10M dataset loader stub. Verifies the typed
 * shape, slicing logic, and conversation-id filtering against the
 * deterministic stub fixture (no HuggingFace download required).
 */

import { describe, it, expect } from 'vitest';
import {
  loadBeam10MDataset,
  estimateBeamCost,
  type Beam10MDataset,
} from '../beam-10m-loader.js';

describe('loadBeam10MDataset — shape', () => {
  it('returns the canonical 10-conversation × 20-question stub by default', async () => {
    const ds = await loadBeam10MDataset();
    expect(ds.schemaVersion).toBe('beam-10m.v1');
    expect(ds.tier).toBe('10M');
    expect(ds.conversations).toHaveLength(10);
    expect(ds.totalQuestions).toBe(200);
    for (const conv of ds.conversations) {
      expect(conv.questions).toHaveLength(20);
      expect(conv.sessions.length).toBeGreaterThan(0);
      expect(conv.approxTokens).toBeGreaterThan(1_000_000);
    }
  });

  it('every question has all required fields and a valid ability code', async () => {
    const ds = await loadBeam10MDataset();
    const validAbilities = new Set([
      'ABS', 'CR', 'EO', 'IE', 'IF', 'KU', 'MSR', 'PF', 'SUM', 'TR',
    ]);
    for (const conv of ds.conversations) {
      for (const q of conv.questions) {
        expect(typeof q.id).toBe('string');
        expect(typeof q.question).toBe('string');
        expect(typeof q.ideal).toBe('string');
        expect(Array.isArray(q.rubric)).toBe(true);
        expect(validAbilities.has(q.ability)).toBe(true);
      }
    }
  });

  it('produces a balanced ability mix (2 questions per ability per conv)', async () => {
    const ds = await loadBeam10MDataset();
    for (const conv of ds.conversations) {
      const counts: Record<string, number> = {};
      for (const q of conv.questions) {
        counts[q.ability] = (counts[q.ability] ?? 0) + 1;
      }
      // 20 questions / 10 abilities = 2 each
      for (const ability of Object.keys(counts)) {
        expect(counts[ability]).toBe(2);
      }
    }
  });
});

describe('loadBeam10MDataset — sliceSize', () => {
  it('limits questions per conversation to sliceSize', async () => {
    const ds = await loadBeam10MDataset({ sliceSize: 5 });
    expect(ds.conversations).toHaveLength(10);
    for (const conv of ds.conversations) {
      expect(conv.questions.length).toBe(5);
    }
    expect(ds.totalQuestions).toBe(50);
  });

  it('sliceSize 0 yields zero questions but keeps conversations', async () => {
    const ds = await loadBeam10MDataset({ sliceSize: 0 });
    expect(ds.conversations).toHaveLength(10);
    expect(ds.totalQuestions).toBe(0);
  });

  it('sliceSize larger than 20 returns all 20 (no over-fetch)', async () => {
    const ds = await loadBeam10MDataset({ sliceSize: 1000 });
    expect(ds.totalQuestions).toBe(200);
  });
});

describe('loadBeam10MDataset — conversationIds', () => {
  it('filters to a single conversation', async () => {
    const ds = await loadBeam10MDataset({ conversationIds: [1] });
    expect(ds.conversations).toHaveLength(1);
    expect(ds.conversations[0].conversationId).toBe(1);
    expect(ds.totalQuestions).toBe(20);
  });

  it('filters to multiple conversations preserving order', async () => {
    const ds = await loadBeam10MDataset({ conversationIds: [3, 5, 7] });
    expect(ds.conversations.map((c) => c.conversationId)).toEqual([3, 5, 7]);
    expect(ds.totalQuestions).toBe(60);
  });

  it('an empty conversationIds array is treated as "all" (no filter)', async () => {
    const ds = await loadBeam10MDataset({ conversationIds: [] });
    expect(ds.conversations).toHaveLength(10);
  });

  it('combines conversationIds + sliceSize for smoke-test scope', async () => {
    const ds = await loadBeam10MDataset({ conversationIds: [1], sliceSize: 20 });
    expect(ds.conversations).toHaveLength(1);
    expect(ds.totalQuestions).toBe(20);
  });
});

describe('estimateBeamCost', () => {
  it('estimates ~$20 + ingest + summaries for the full 10-conv × 200-question set', async () => {
    const ds = await loadBeam10MDataset();
    const cost = estimateBeamCost(ds, { hierarchicalEnabled: true });
    expect(cost.questionsUsd).toBeCloseTo(20, 0); // 200 × $0.10
    expect(cost.ingestUsd).toBeGreaterThan(0);
    expect(cost.summaryUsd).toBeGreaterThan(0);
    expect(cost.totalUsd).toBeCloseTo(
      cost.questionsUsd + cost.ingestUsd + cost.summaryUsd,
      6,
    );
  });

  it('summary cost is zero when hierarchical disabled', async () => {
    const ds = await loadBeam10MDataset();
    const cost = estimateBeamCost(ds, { hierarchicalEnabled: false });
    expect(cost.summaryUsd).toBe(0);
  });

  it('smoke (conv-1, 20 q) total cost ~ $4', async () => {
    const ds = await loadBeam10MDataset({ conversationIds: [1], sliceSize: 20 });
    const cost = estimateBeamCost(ds, { hierarchicalEnabled: true });
    // 1 conv × 150 facts × $0.002 = $0.30 ingest
    // 1 conv × 50 sessions × $0.001 + 1 × $0.005 = $0.055 summaries
    // 20 q × $0.10 = $2.00 questions
    expect(cost.totalUsd).toBeLessThan(5);
    expect(cost.totalUsd).toBeGreaterThan(2);
  });
});

describe('Beam10MDataset typed shape (compile-time guard)', () => {
  it('exposes the expected schemaVersion literal', async () => {
    const ds: Beam10MDataset = await loadBeam10MDataset();
    // Compile-time: schemaVersion is the literal 'beam-10m.v1'
    const v: 'beam-10m.v1' = ds.schemaVersion;
    expect(v).toBe('beam-10m.v1');
  });
});
