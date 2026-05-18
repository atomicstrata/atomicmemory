/**
 * Unit tests for answer-verifier (Sprint 3 v1.7 — H5).
 */
import { describe, expect, it } from 'vitest';
import { verifyAnswer, AnswerVerifierError } from '../answer-verifier.js';
import type { ChatMessage, LLMProvider } from '../llm.js';

function stub(reply: string): LLMProvider {
  return {
    async chat(_m: ChatMessage[]): Promise<string> {
      return reply;
    },
  } as unknown as LLMProvider;
}

describe('verifyAnswer', () => {
  it('returns the verified answer on a clean response', async () => {
    const out = await verifyAnswer(
      'Q',
      'CTX',
      'A',
      stub('{"verified_answer":"A","changed":false}'),
    );
    expect(out).toEqual({ verified_answer: 'A', changed: false });
  });

  it('throws on empty candidate', async () => {
    await expect(
      verifyAnswer('Q', 'CTX', '', stub('{"verified_answer":"x","changed":false}')),
    ).rejects.toBeInstanceOf(AnswerVerifierError);
  });

  it('throws on non-JSON', async () => {
    await expect(
      verifyAnswer('Q', 'CTX', 'A', stub('not json')),
    ).rejects.toBeInstanceOf(AnswerVerifierError);
  });

  it('throws when verified_answer is empty', async () => {
    await expect(
      verifyAnswer('Q', 'CTX', 'A', stub('{"verified_answer":"","changed":true}')),
    ).rejects.toBeInstanceOf(AnswerVerifierError);
  });
});
