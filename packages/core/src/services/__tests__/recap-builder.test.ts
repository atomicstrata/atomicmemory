/**
 * Unit tests for the Recap layer LLM synthesis (Sprint 3 v1).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, LLMProvider } from '../llm.js';
import { RecapBuilderError, synthesizeRecap } from '../recap-builder.js';

function stubLlm(response: string): LLMProvider {
  return {
    chat: vi.fn(async (_messages: ChatMessage[], _options?: ChatOptions) => response),
  };
}

const TOPIC = 'API authentication design';
const MEMS = [
  'User decided to use Flask-Login for sessions on Mar 15',
  'User added password hashing via bcrypt on Mar 17',
  'User integrated JWT for API endpoints on Mar 22',
  'User wired up account-lockout after 5 failed logins on Mar 24',
];

const VALID_NARRATIVE = 'On March 15 the user chose Flask-Login for session management. ' +
  'Two days later password hashing was added via bcrypt for stronger credential storage. ' +
  'By March 22 the design extended to JWT for API endpoints, and by March 24 ' +
  'account lockout after five failed logins was implemented to mitigate brute force attacks.';

describe('synthesizeRecap', () => {
  it('returns a clean narrative for a well-formed JSON response', async () => {
    const llm = stubLlm(JSON.stringify({ narrative: VALID_NARRATIVE }));
    const result = await synthesizeRecap(TOPIC, MEMS, llm);
    expect(result.narrative).toContain('Flask-Login');
    expect(result.narrative).toContain('JWT');
    expect(result.narrative.length).toBeGreaterThan(50);
  });

  it('strips markdown fences from LLM output', async () => {
    const llm = stubLlm('```json\n' + JSON.stringify({ narrative: VALID_NARRATIVE }) + '\n```');
    const result = await synthesizeRecap(TOPIC, MEMS, llm);
    expect(result.narrative).toContain('Flask-Login');
  });

  it('throws RecapBuilderError on empty memberContents', async () => {
    const llm = stubLlm(JSON.stringify({ narrative: VALID_NARRATIVE }));
    await expect(synthesizeRecap(TOPIC, [], llm)).rejects.toThrow(/zero members/);
  });

  it('throws RecapBuilderError on non-JSON output', async () => {
    const llm = stubLlm('not json at all');
    await expect(synthesizeRecap(TOPIC, MEMS, llm)).rejects.toThrow(RecapBuilderError);
  });

  it('throws RecapBuilderError on missing narrative field', async () => {
    const llm = stubLlm('{"other": "value"}');
    await expect(synthesizeRecap(TOPIC, MEMS, llm)).rejects.toThrow(/missing narrative/);
  });

  it('throws RecapBuilderError on too-short narrative', async () => {
    const llm = stubLlm('{"narrative": "too short"}');
    await expect(synthesizeRecap(TOPIC, MEMS, llm)).rejects.toThrow(/too short/);
  });

  it('throws RecapBuilderError on LLM transport failure', async () => {
    const llm: LLMProvider = {
      chat: vi.fn(async () => {
        throw new Error('upstream timeout');
      }),
    };
    await expect(synthesizeRecap(TOPIC, MEMS, llm)).rejects.toThrow(/upstream timeout/);
  });

  it('throws RecapBuilderError on empty LLM output', async () => {
    const llm = stubLlm('');
    await expect(synthesizeRecap(TOPIC, MEMS, llm)).rejects.toThrow(/empty/);
  });

  it('passes correct chat options (low temp + json mode + bounded tokens)', async () => {
    const chat: LLMProvider['chat'] = vi.fn(async () => JSON.stringify({ narrative: VALID_NARRATIVE }));
    const llm: LLMProvider = { chat };
    await synthesizeRecap(TOPIC, MEMS, llm);
    const mock = chat as unknown as { mock: { calls: Array<[ChatMessage[], ChatOptions | undefined]> } };
    const [messages, opts] = mock.mock.calls[0]!;
    const safeOpts = opts ?? ({} as ChatOptions);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.content).toContain(TOPIC);
    expect(messages[1]!.content).toContain('Flask-Login');
    expect(safeOpts.temperature).toBe(0);
    expect(safeOpts.jsonMode).toBe(true);
    expect(safeOpts.maxTokens! >= 256).toBe(true);
  });
});
