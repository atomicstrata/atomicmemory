/**
 * Unit tests for the hierarchical-retrieval summary generator.
 * Mocks the LLMProvider to assert prompt shape, JSON parsing, and the
 * deterministic-skip-for-small-sessions branch.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateSessionSummary,
  generateConvSummary,
} from '../session-summary-generator.js';
import type { LLMProvider, ChatMessage, ChatOptions } from '../llm.js';

function makeMockLlm(responses: string[]): { llm: LLMProvider; calls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> } {
  const calls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
  let i = 0;
  const llm: LLMProvider = {
    chat: async (messages, options) => {
      calls.push({ messages, options });
      const r = responses[i] ?? responses[responses.length - 1] ?? '';
      i += 1;
      return r;
    },
  };
  return { llm, calls };
}

describe('generateSessionSummary', () => {
  it('skips the LLM and returns a deterministic summary when fewer than 5 facts', async () => {
    const { llm, calls } = makeMockLlm(['UNUSED']);
    const out = await generateSessionSummary(['Alice loves Postgres.', 'Team chose JWT.'], llm);
    expect(out.llmInvoked).toBe(false);
    expect(out.summary).toContain('Postgres');
    expect(out.topics.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it('extracts longest tokens as topics in the deterministic branch', async () => {
    const { llm } = makeMockLlm([]);
    const facts = ['Apple banana', 'Apple banana', 'Cherry'];
    const out = await generateSessionSummary(facts, llm);
    expect(out.topics).toContain('apple');
    expect(out.topics).toContain('banana');
  });

  it('invokes the LLM when ≥ 5 facts and parses {summary, topics} JSON', async () => {
    const json = JSON.stringify({
      summary: 'Project kickoff: chose Postgres + JWT auth.',
      topics: ['postgres', 'jwt', 'kickoff'],
    });
    const { llm, calls } = makeMockLlm([json]);
    const facts = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = await generateSessionSummary(facts, llm);
    expect(out.llmInvoked).toBe(true);
    expect(out.summary).toBe('Project kickoff: chose Postgres + JWT auth.');
    expect(out.topics).toEqual(['postgres', 'jwt', 'kickoff']);
    expect(calls).toHaveLength(1);
  });

  it('passes jsonMode=true and a maxTokens cap to the LLM provider', async () => {
    const { llm, calls } = makeMockLlm([JSON.stringify({ summary: 's', topics: [] })]);
    await generateSessionSummary(['1', '2', '3', '4', '5'], llm, { seed: 42 });
    expect(calls[0].options?.jsonMode).toBe(true);
    expect(calls[0].options?.maxTokens).toBeGreaterThan(0);
    expect(calls[0].options?.seed).toBe(42);
  });

  it('emits a system + user message in the prompt', async () => {
    const { llm, calls } = makeMockLlm([JSON.stringify({ summary: 's', topics: [] })]);
    await generateSessionSummary(['1', '2', '3', '4', '5'], llm);
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[0].content).toContain('JSON');
    expect(calls[0].messages[1].role).toBe('user');
    expect(calls[0].messages[1].content).toContain('Session facts');
  });

  it('caps topics at 8 entries', async () => {
    const json = JSON.stringify({
      summary: 's',
      topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'],
    });
    const { llm } = makeMockLlm([json]);
    const out = await generateSessionSummary(['1', '2', '3', '4', '5'], llm);
    expect(out.topics).toHaveLength(8);
  });

  it('falls back to deterministic summary when LLM emits invalid JSON', async () => {
    const { llm } = makeMockLlm(['{not real json']);
    const out = await generateSessionSummary(['1', '2', '3', '4', '5'], llm);
    expect(out.llmInvoked).toBe(true);
    // deterministic fallback uses the input facts directly
    expect(out.summary).toContain('1');
  });

  it('tolerates ```json fenced output', async () => {
    const json = '```json\n' + JSON.stringify({ summary: 'fenced', topics: ['x'] }) + '\n```';
    const { llm } = makeMockLlm([json]);
    const out = await generateSessionSummary(['1', '2', '3', '4', '5'], llm);
    expect(out.summary).toBe('fenced');
  });

  it('respects the minFactsForLlm option override', async () => {
    const { llm, calls } = makeMockLlm([JSON.stringify({ summary: 's', topics: [] })]);
    // With override = 2, three facts should invoke the LLM
    await generateSessionSummary(['a', 'b', 'c'], llm, { minFactsForLlm: 2 });
    expect(calls).toHaveLength(1);
  });
});

describe('generateConvSummary', () => {
  it('skips the LLM and joins summaries when fewer than 5 sessions', async () => {
    const { llm, calls } = makeMockLlm(['UNUSED']);
    const out = await generateConvSummary(['s1 summary', 's2 summary'], llm);
    expect(out.llmInvoked).toBe(false);
    expect(out.summary).toContain('s1');
    expect(out.summary).toContain('s2');
    expect(calls).toHaveLength(0);
  });

  it('invokes the LLM when ≥ 5 session summaries and parses {summary} JSON', async () => {
    const json = JSON.stringify({ summary: 'Three-week project arc covering kickoff to deploy.' });
    const { llm, calls } = makeMockLlm([json]);
    const summaries = ['a', 'b', 'c', 'd', 'e'];
    const out = await generateConvSummary(summaries, llm);
    expect(out.llmInvoked).toBe(true);
    expect(out.summary).toBe('Three-week project arc covering kickoff to deploy.');
    expect(calls).toHaveLength(1);
  });

  it('emits sessions in chronological order in the prompt', async () => {
    const { llm, calls } = makeMockLlm([JSON.stringify({ summary: 's' })]);
    await generateConvSummary(['first', 'second', 'third', 'fourth', 'fifth'], llm);
    const userMsg = calls[0].messages[1].content;
    expect(userMsg.indexOf('first')).toBeLessThan(userMsg.indexOf('second'));
    expect(userMsg.indexOf('second')).toBeLessThan(userMsg.indexOf('third'));
  });

  it('returns trimmed raw text when LLM emits invalid JSON', async () => {
    const { llm } = makeMockLlm(['just plain text fallback content']);
    const out = await generateConvSummary(['s1', 's2', 's3', 's4', 's5'], llm);
    expect(out.llmInvoked).toBe(true);
    expect(out.summary).toContain('plain text');
  });
});
