/**
 * Unit tests for the always-on ENTITY_CARD synthesis service.
 * Mocks the LLM tool-use call. No database, no network — pure orchestration.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  groupObservationsByEntity,
  synthesizeCards,
  type ObservationForCard,
  type SynthesizeCardsDeps,
} from '../entity-card-synthesis.js';

const D = (s: string) => new Date(s);

describe('groupObservationsByEntity', () => {
  it('groups user-prefixed observations under the canonical "user" entity', () => {
    const obs: ObservationForCard[] = [
      { id: 'o1', text: 'User uses Flask 3.1', type: 'entity_state', observedAt: D('2026-03-01') },
      { id: 'o2', text: 'user prefers Python', type: 'preference', observedAt: D('2026-03-02') },
      { id: 'o3', text: 'The user added a column', type: 'event_summary', observedAt: D('2026-03-03') },
    ];
    const grouped = groupObservationsByEntity(obs);
    expect(grouped.has('user')).toBe(true);
    expect(grouped.get('user')).toHaveLength(3);
  });

  it('groups capitalized-prefix observations under the noun phrase', () => {
    const obs: ObservationForCard[] = [
      { id: 'o1', text: 'Flask-Login v0.6.2 is in use', type: 'entity_state', observedAt: D('2026-03-01') },
      { id: 'o2', text: 'Flask-Login replaces session middleware', type: 'event_summary', observedAt: D('2026-03-02') },
    ];
    const grouped = groupObservationsByEntity(obs);
    expect(grouped.has('Flask-Login')).toBe(true);
    expect(grouped.get('Flask-Login')).toHaveLength(2);
  });

  it('skips observations without a clear entity prefix', () => {
    const obs: ObservationForCard[] = [
      { id: 'o1', text: '404 errors must show a custom page', type: 'preference', observedAt: D('2026-03-01') },
    ];
    const grouped = groupObservationsByEntity(obs);
    // '404' starts with a digit, not capitalized — skipped.
    expect(grouped.size).toBe(0);
  });
});

describe('synthesizeCards', () => {
  const deps = (call: SynthesizeCardsDeps['llmCallTool']): SynthesizeCardsDeps => ({
    llmCallTool: call,
    minObservations: 3,
    maxEntities: 5,
  });

  it('synthesizes one card per entity with >= minObservations', async () => {
    const obs: ObservationForCard[] = [
      { id: 'o1', text: 'User uses Flask', type: 'entity_state', observedAt: D('2026-03-01') },
      { id: 'o2', text: 'user prefers Python', type: 'preference', observedAt: D('2026-03-02') },
      { id: 'o3', text: 'The user added a column', type: 'event_summary', observedAt: D('2026-03-03') },
    ];
    const call = vi.fn().mockResolvedValue({ card_text: 'identity: power user\ncurrent_values: Flask' });
    const cards = await synthesizeCards(obs, new Map(), deps(call));
    expect(call).toHaveBeenCalledTimes(1);
    expect(cards).toHaveLength(1);
    expect(cards[0].entityName).toBe('user');
    expect(cards[0].cardText).toContain('Flask');
    expect(cards[0].sourceObservationIds).toEqual(['o1', 'o2', 'o3']);
  });

  it('skips entities with fewer than minObservations', async () => {
    const obs: ObservationForCard[] = [
      { id: 'o1', text: 'User uses Flask', type: 'entity_state', observedAt: D('2026-03-01') },
      { id: 'o2', text: 'user prefers Python', type: 'preference', observedAt: D('2026-03-02') },
    ];
    const call = vi.fn();
    const cards = await synthesizeCards(obs, new Map(), deps(call));
    expect(call).not.toHaveBeenCalled();
    expect(cards).toEqual([]);
  });

  it('threads prior card text into the synthesis prompt', async () => {
    const obs: ObservationForCard[] = [
      { id: 'o1', text: 'User uses Flask', type: 'entity_state', observedAt: D('2026-03-01') },
      { id: 'o2', text: 'user prefers Python', type: 'preference', observedAt: D('2026-03-02') },
      { id: 'o3', text: 'The user added a column', type: 'event_summary', observedAt: D('2026-03-03') },
    ];
    const call = vi.fn().mockResolvedValue({ card_text: 'updated card' });
    const prior = new Map([['user', 'identity: Alice (prior)']]);
    await synthesizeCards(obs, prior, deps(call));
    const userMsg = call.mock.calls[0][1] as string;
    expect(userMsg).toContain('identity: Alice (prior)');
    expect(userMsg).toContain('User uses Flask');
  });

  it('drops cards whose llmCallTool returns empty card_text', async () => {
    const obs: ObservationForCard[] = [
      { id: 'o1', text: 'User uses Flask', type: 'entity_state', observedAt: D('2026-03-01') },
      { id: 'o2', text: 'user prefers Python', type: 'preference', observedAt: D('2026-03-02') },
      { id: 'o3', text: 'The user added a column', type: 'event_summary', observedAt: D('2026-03-03') },
    ];
    const call = vi.fn().mockResolvedValue({ card_text: '   ' });
    const cards = await synthesizeCards(obs, new Map(), deps(call));
    expect(cards).toEqual([]);
  });
});
