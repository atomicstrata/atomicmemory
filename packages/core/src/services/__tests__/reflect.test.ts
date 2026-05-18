import { describe, expect, it, vi } from 'vitest';
import { runReflectForConversation, type ReflectDeps } from '../reflect.js';

const memories = [
  { id: 'm1', text: 'first', observedAt: new Date('2026-03-01') },
  { id: 'm2', text: 'second', observedAt: new Date('2026-03-02') },
];

const toolOutput = {
  observations: [
    { text: 'O1', type: 'event_summary' as const, evidence_memory_ids: ['m1', 'm2'] },
    { text: 'O2', type: 'preference' as const, evidence_memory_ids: ['m1'] },
  ],
};

describe('runReflectForConversation', () => {
  it('calls LLM with built messages, embeds each observation, persists with citations', async () => {
    const insertMany = vi.fn().mockResolvedValue(undefined);
    const llmTool = vi.fn().mockResolvedValue(toolOutput);
    const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    const fetchMemories = vi.fn().mockResolvedValue(memories);
    const deps: ReflectDeps = {
      fetchMemories,
      llmCallTool: llmTool,
      embed,
      reflections: { insertMany } as any,
      maxObservations: 15,
    };
    const res = await runReflectForConversation(deps, 'u1', 'c1');
    expect(fetchMemories).toHaveBeenCalledWith('u1', 'c1');
    expect(llmTool).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(insertMany).toHaveBeenCalledTimes(1);
    const inserted = insertMany.mock.calls[0][0];
    expect(inserted).toHaveLength(2);
    expect(inserted[0].observation).toBe('O1');
    expect(inserted[0].evidenceMemoryIds).toEqual(['m1', 'm2']);
    expect(res.count).toBe(2);
    expect(res.entityCardCount).toBe(0);
  });

  it('returns count=0 when conversation has no memories', async () => {
    const deps: ReflectDeps = {
      fetchMemories: vi.fn().mockResolvedValue([]),
      llmCallTool: vi.fn(),
      embed: vi.fn(),
      reflections: { insertMany: vi.fn() } as any,
      maxObservations: 15,
    };
    const res = await runReflectForConversation(deps, 'u1', 'c1');
    expect(res.count).toBe(0);
    expect(res.entityCardCount).toBe(0);
    expect(deps.llmCallTool).not.toHaveBeenCalled();
  });

  it('truncates observations to maxObservations', async () => {
    const insertMany = vi.fn().mockResolvedValue(undefined);
    const big = { observations: Array.from({ length: 20 }, (_, i) => ({
      text: `O${i}`, type: 'event_summary' as const, evidence_memory_ids: ['m1'],
    })) };
    const deps: ReflectDeps = {
      fetchMemories: vi.fn().mockResolvedValue(memories),
      llmCallTool: vi.fn().mockResolvedValue(big),
      embed: vi.fn().mockResolvedValue([0.1]),
      reflections: { insertMany } as any,
      maxObservations: 5,
    };
    const res = await runReflectForConversation(deps, 'u1', 'c1');
    expect(res.count).toBe(5);
  });
});
