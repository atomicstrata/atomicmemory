/**
 * Unit tests for user-profile-builder (Sprint 3 v1.5 — H2).
 */
import { describe, expect, it } from 'vitest';
import { synthesizeUserProfile, UserProfileBuilderError } from '../user-profile-builder.js';
import type { ChatMessage, LLMProvider } from '../llm.js';

function stubLlm(reply: string): LLMProvider {
  return {
    async chat(_msgs: ChatMessage[]): Promise<string> {
      return reply;
    },
  } as unknown as LLMProvider;
}

describe('synthesizeUserProfile', () => {
  it('throws on zero memories', async () => {
    await expect(
      synthesizeUserProfile([], stubLlm('{"profile":"..."}')),
    ).rejects.toBeInstanceOf(UserProfileBuilderError);
  });

  it('returns the trimmed profile on valid response', async () => {
    const longProfile =
      'Preferences: user likes concise answers and tabs. Instructions: respond in English. Open commitments: finalize the weather app. ' +
      'word '.repeat(30);
    const llm = stubLlm(JSON.stringify({ profile: longProfile }));
    const out = await synthesizeUserProfile(['I prefer tabs', 'Reply in English'], llm);
    expect(out.profile.startsWith('Preferences:')).toBe(true);
  });

  it('throws on non-JSON response', async () => {
    await expect(
      synthesizeUserProfile(['x'], stubLlm('not json at all')),
    ).rejects.toBeInstanceOf(UserProfileBuilderError);
  });

  it('throws when profile too short', async () => {
    await expect(
      synthesizeUserProfile(['x'], stubLlm(JSON.stringify({ profile: 'too short' }))),
    ).rejects.toBeInstanceOf(UserProfileBuilderError);
  });
});
