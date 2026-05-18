/**
 * Unit tests for the topic-abstraction layer (Sprint 3 EO experiment).
 *
 * Three concerns under test:
 *   1. Happy path: well-formed JSON returns a clean topic.
 *   2. Robustness: fenced JSON / extra prose / extra whitespace is parsed.
 *   3. Fail-closed: bad LLM output (non-JSON, missing field, wrong word
 *      count) raises TopicAbstractionError. No silent fallback.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, LLMProvider } from '../llm.js';
import {
  TopicAbstractionError,
  extractTopicAbstraction,
} from '../topic-abstraction.js';

const CHUNK = 'User: I started building a personal budget tracker in Flask. Assistant: nice — what features?';
const FACT = 'User is building a personal budget tracker.';

function stubLlm(response: string): LLMProvider {
  return {
    chat: vi.fn(async (_messages: ChatMessage[], _options?: ChatOptions) => response),
  };
}

describe('extractTopicAbstraction', () => {
  it('returns a clean topic for a well-formed JSON response', async () => {
    const llm = stubLlm('{"topic": "personal budget tracker development"}');
    const result = await extractTopicAbstraction(CHUNK, FACT, llm);
    expect(result.topic).toBe('personal budget tracker development');
  });

  it('strips markdown code fences from the LLM response', async () => {
    const llm = stubLlm('```json\n{"topic": "API authentication design"}\n```');
    const result = await extractTopicAbstraction(CHUNK, FACT, llm);
    expect(result.topic).toBe('API authentication design');
  });

  it('tolerates leading prose and extra whitespace', async () => {
    const llm = stubLlm('Sure, here is the topic:\n\n   {"topic":   "deployment pipeline setup"}   ');
    const result = await extractTopicAbstraction(CHUNK, FACT, llm);
    expect(result.topic).toBe('deployment pipeline setup');
  });

  it('throws TopicAbstractionError on non-JSON output', async () => {
    const llm = stubLlm('not actually json');
    await expect(extractTopicAbstraction(CHUNK, FACT, llm)).rejects.toThrow(TopicAbstractionError);
  });

  it('throws TopicAbstractionError on missing topic field', async () => {
    const llm = stubLlm('{"other_field": "value"}');
    await expect(extractTopicAbstraction(CHUNK, FACT, llm)).rejects.toThrow(/no topic field/);
  });

  it('throws TopicAbstractionError on too-short topic (< 3 words)', async () => {
    const llm = stubLlm('{"topic": "code work"}');
    await expect(extractTopicAbstraction(CHUNK, FACT, llm)).rejects.toThrow(/3-7 words/);
  });

  it('throws TopicAbstractionError on too-long topic (> 7 words)', async () => {
    const llm = stubLlm('{"topic": "this is a topic with way more than seven words"}');
    await expect(extractTopicAbstraction(CHUNK, FACT, llm)).rejects.toThrow(/3-7 words/);
  });

  it('throws TopicAbstractionError on empty topic', async () => {
    const llm = stubLlm('{"topic": ""}');
    await expect(extractTopicAbstraction(CHUNK, FACT, llm)).rejects.toThrow(/no topic field/);
  });

  it('throws TopicAbstractionError on LLM transport failure', async () => {
    const llm: LLMProvider = {
      chat: vi.fn(async () => {
        throw new Error('upstream timeout');
      }),
    };
    await expect(extractTopicAbstraction(CHUNK, FACT, llm)).rejects.toThrow(/topic extraction LLM call failed.*upstream timeout/);
  });

  it('throws TopicAbstractionError on empty LLM output', async () => {
    const llm = stubLlm('');
    await expect(extractTopicAbstraction(CHUNK, FACT, llm)).rejects.toThrow(/empty content/);
  });

  it('passes correct chat options (low temp + json mode + bounded tokens)', async () => {
    const chat: LLMProvider['chat'] = vi.fn(async (_messages: ChatMessage[], _options?: ChatOptions) => '{"topic": "frontend layout iteration"}');
    const llm: LLMProvider = { chat };
    await extractTopicAbstraction(CHUNK, FACT, llm);
    const mock = chat as unknown as { mock: { calls: Array<[ChatMessage[], ChatOptions | undefined]> } };
    expect(mock.mock.calls.length).toBe(1);
    const [messages, opts] = mock.mock.calls[0]!;
    const safeOpts = opts ?? ({} as ChatOptions);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('CHAT FRAGMENT');
    expect(messages[1]!.content).toContain('FACT EXTRACTED');
    expect(safeOpts.temperature).toBe(0);
    expect(safeOpts.jsonMode).toBe(true);
    expect(safeOpts.maxTokens).toBeDefined();
    expect(safeOpts.maxTokens! >= 64).toBe(true);
  });

  it('normalizes internal whitespace in the topic', async () => {
    const llm = stubLlm('{"topic": "  database\\tmigration\\nplanning  "}');
    const result = await extractTopicAbstraction(CHUNK, FACT, llm);
    expect(result.topic).toBe('database migration planning');
  });
});
