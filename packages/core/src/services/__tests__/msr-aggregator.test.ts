/**
 * Unit tests for the MSR aggregator. LLM is mocked via a stub provider;
 * no DB and no network.
 */

import { describe, expect, it, vi } from 'vitest';
import { aggregateByConversation } from '../msr-aggregator.js';
import type { SearchResult } from '../../db/memory-repository.js';
import type { ChatMessage, ChatOptions, LLMProvider } from '../llm.js';

/** Minimal SearchResult factory — only the fields the aggregator reads. */
function fakeMemory(id: string, episodeId: string | null, content: string): SearchResult {
  return {
    id,
    user_id: 'u1',
    content,
    embedding: [],
    memory_type: 'memory',
    importance: 0.5,
    source_site: 'test',
    source_url: '',
    episode_id: episodeId,
    status: 'active',
    metadata: {},
    keywords: '',
    namespace: null,
    summary: '',
    overview: '',
    trust_score: 1,
    observed_at: new Date(),
    created_at: new Date(),
    last_accessed_at: new Date(),
    access_count: 0,
    expired_at: null,
    deleted_at: null,
    network: '',
    opinion_confidence: null,
    observation_subject: null,
    similarity: 0.9,
    score: 0.9,
  } as SearchResult;
}

function stubLlm(replies: string[]): LLMProvider {
  const queue = [...replies];
  return {
    chat: vi.fn(async (_msgs: ChatMessage[], _opts?: ChatOptions) => {
      const next = queue.shift();
      if (next === undefined) throw new Error('stubLlm: ran out of canned replies');
      return next;
    }),
  };
}

describe('aggregateByConversation', () => {
  it('returns empty string when there are no memories', async () => {
    const llm = stubLlm([]);
    const out = await aggregateByConversation([], 'q', { llm, model: 'claude-haiku-4-5' });
    expect(out).toBe('');
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('passes through verbatim when a single group has one memory (no LLM call)', async () => {
    const llm = stubLlm([]);
    const memories = [fakeMemory('m1', 'e1', 'Wants OAuth login.')];
    const out = await aggregateByConversation(memories, 'q', { llm, model: 'claude-haiku-4-5' });
    expect(out).toBe('## CONVERSATION 1 SUMMARY\nWants OAuth login.');
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('summarizes one multi-memory group via the LLM exactly once', async () => {
    const llm = stubLlm(['Discussed OAuth and role-based access.']);
    const memories = [
      fakeMemory('m1', 'e1', 'Wants OAuth login.'),
      fakeMemory('m2', 'e1', 'Wants role-based access control.'),
    ];
    const out = await aggregateByConversation(memories, 'security features?', {
      llm,
      model: 'claude-haiku-4-5',
    });
    expect(out).toBe('## CONVERSATION 1 SUMMARY\nDiscussed OAuth and role-based access.');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('mixes pass-through and summary across three groups (one LLM call only for multi-memory)', async () => {
    const llm = stubLlm(['Two weather features discussed.', 'Two security features discussed.']);
    const memories = [
      // Group 1: two memories, episode e1 → summarized
      fakeMemory('m1', 'e1', 'Mentioned forecast feature.'),
      fakeMemory('m2', 'e1', 'Mentioned alerts feature.'),
      // Group 2: one memory, episode e2 → verbatim
      fakeMemory('m3', 'e2', 'Wants graphs in the dashboard.'),
      // Group 3: two memories, null episode → summarized
      fakeMemory('m4', null, 'Wants OAuth.'),
      fakeMemory('m5', null, 'Wants RBAC.'),
    ];
    const out = await aggregateByConversation(memories, 'features?', {
      llm,
      model: 'claude-haiku-4-5',
    });
    expect(out).toContain('## CONVERSATION 1 SUMMARY\nTwo weather features discussed.');
    expect(out).toContain('## CONVERSATION 2 SUMMARY\nWants graphs in the dashboard.');
    expect(out).toContain('## CONVERSATION 3 SUMMARY\nTwo security features discussed.');
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the LLM returns an empty string for a multi-memory group', async () => {
    const llm = stubLlm(['   ']);
    const memories = [fakeMemory('m1', 'e1', 'a'), fakeMemory('m2', 'e1', 'b')];
    await expect(
      aggregateByConversation(memories, 'q', { llm, model: 'claude-haiku-4-5' }),
    ).rejects.toThrow(/empty summary/i);
  });
});
