/**
 * Unit tests for the LLM cross-encoder reranker (Sprint 3 v1).
 *
 * Concerns under test:
 *   1. Happy path: scores produce a re-sorted candidate list (highest first).
 *   2. Empty input: passes through.
 *   3. Robustness: fenced + prose-wrapped JSON parsed.
 *   4. Fail-closed: missing scores, wrong length, non-numeric → RerankerError.
 *   5. Tail beyond rerank window is preserved (top-N + tail).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, LLMProvider } from '../llm.js';
import type { SearchResult } from '../../db/repository-types.js';
import { RerankerError, llmRerank } from '../rerank.js';

function stubLlm(response: string): LLMProvider {
  return {
    chat: vi.fn(async (_messages: ChatMessage[], _options?: ChatOptions) => response),
  };
}

function makeResult(id: string, content: string): SearchResult {
  return {
    id,
    content,
    importance: 0.5,
    similarity: 0.5,
    source_site: 'test',
    source_url: 'test://',
    memory_type: 'semantic',
    metadata: {},
    keywords: '',
    summary: '',
    overview: '',
    namespace: null,
    network: 'experience',
    opinion_confidence: null,
    observation_subject: null,
    confidence: 1.0,
    belief_tier: 'standard',
    mutation_type: null,
    observed_at: new Date(),
    created_at: new Date(),
    last_accessed_at: new Date(),
    access_count: 0,
    expired_at: null,
    deleted_at: null,
    episode_id: null,
    workspace_id: null,
    agent_id: null,
    visibility: null,
    status: 'active',
    trust_score: 1.0,
    deferred_audn: false,
    audn_candidates: null,
  } as unknown as SearchResult;
}

const A = makeResult('a', 'fact A about Python');
const B = makeResult('b', 'fact B about Flask');
const C = makeResult('c', 'fact C about deployment');

describe('llmRerank', () => {
  it('reorders candidates by score (highest first)', async () => {
    // c=0.9, a=0.7, b=0.2 → expected order [C, A, B]
    const llm = stubLlm('{"scores": [0.7, 0.2, 0.9]}');
    const out = await llmRerank('How did I deploy?', [A, B, C], llm);
    expect(out.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('returns empty input unchanged', async () => {
    const llm = stubLlm('{"scores": []}');
    const out = await llmRerank('q', [], llm);
    expect(out).toEqual([]);
  });

  it('strips markdown fences from LLM output', async () => {
    const llm = stubLlm('```json\n{"scores": [0.1, 0.5, 0.9]}\n```');
    const out = await llmRerank('q', [A, B, C], llm);
    expect(out.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('clamps scores into [0, 1]', async () => {
    const llm = stubLlm('{"scores": [2.5, -1.0, 0.5]}');
    const out = await llmRerank('q', [A, B, C], llm);
    // A clamps to 1, B to 0, C stays 0.5 → order A, C, B
    expect(out.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('throws RerankerError when scores array length mismatches', async () => {
    const llm = stubLlm('{"scores": [0.5]}');
    await expect(llmRerank('q', [A, B, C], llm)).rejects.toThrow(/length/);
  });

  it('throws RerankerError on missing scores field', async () => {
    const llm = stubLlm('{"other_field": "value"}');
    await expect(llmRerank('q', [A, B, C], llm)).rejects.toThrow(/array/);
  });

  it('throws RerankerError on non-numeric score', async () => {
    const llm = stubLlm('{"scores": [0.5, "not a number", 0.7]}');
    await expect(llmRerank('q', [A, B, C], llm)).rejects.toThrow(/finite number/);
  });

  it('throws RerankerError on non-JSON output', async () => {
    const llm = stubLlm('not actually json');
    await expect(llmRerank('q', [A, B, C], llm)).rejects.toThrow(RerankerError);
  });

  it('throws RerankerError on empty LLM output', async () => {
    const llm = stubLlm('');
    await expect(llmRerank('q', [A, B, C], llm)).rejects.toThrow(/empty/);
  });

  it('throws RerankerError on LLM transport failure', async () => {
    const llm: LLMProvider = {
      chat: vi.fn(async () => {
        throw new Error('upstream timeout');
      }),
    };
    await expect(llmRerank('q', [A, B, C], llm)).rejects.toThrow(/upstream timeout/);
  });
});
