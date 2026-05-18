/**
 * Honcho-style user-profile builder (Sprint 3 v1.5 — H2).
 *
 * After a user's ingest stores >= MIN_NEW_MEMORIES_FOR_REBUILD new
 * facts, this builder fires (post-write, fire-and-forget) a single LLM
 * call that synthesizes a ~200-word profile capturing the user's
 * stated preferences, persistent instructions, and open commitments.
 *
 * Failure-closed: throws on JSON parse failure or empty profile.
 * Caller wraps in try/catch to keep ingest latency unaffected.
 */
import type { ChatMessage, LLMProvider } from './llm.js';
import { llm as defaultLlm } from './llm.js';
import { extractFirstJsonObject } from './extraction.js';
import type { MemoryServiceDeps } from './memory-service-types.js';

const PROFILE_MAX_TOKENS = 768;
const PROFILE_TARGET_WORDS = 200;
const MIN_NEW_MEMORIES_FOR_REBUILD = 3;
const MAX_SOURCE_MEMORY_CHARS = 300;
const MAX_SOURCES_PER_BUILD = 40;
const MIN_PROFILE_WORD_COUNT = 20;
const MIN_REBUILD_INTERVAL_MS = 60_000; // 60 s — coalesces bursty ingest into one rebuild

const PROFILE_SYSTEM_PROMPT = [
  'You synthesize a concise user profile from a list of stored memories.',
  '',
  'Rules:',
  '- Capture the user’s explicit preferences, persistent instructions, and open commitments.',
  '- Preserve specific facts (names, dates, decisions). Do not infer or speculate.',
  '- Only state facts present in the numbered memories above. If a memory does not support a claim, do not include it.',
  '- Write ~' + String(PROFILE_TARGET_WORDS) + ' words in three sections:',
  '  1. Preferences: ...',
  '  2. Instructions: ...',
  '  3. Open commitments: ...',
  '- Output JSON: {"profile": "<200-word document>"}.',
  '- No markdown fences. No prose around the JSON.',
].join('\n');

export interface UserProfile {
  profile: string;
}

export class UserProfileBuilderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'UserProfileBuilderError';
  }
}

function buildProfileMessages(memoryContents: string[]): ChatMessage[] {
  const truncated = memoryContents
    .slice(0, MAX_SOURCES_PER_BUILD)
    .map((c, i) => `[${i + 1}] ${c.trim().slice(0, MAX_SOURCE_MEMORY_CHARS)}`);
  return [
    { role: 'system', content: PROFILE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'MEMORIES:',
        truncated.join('\n\n'),
        '',
        'Return JSON: {"profile": "<200-word profile>"}',
      ].join('\n'),
    },
  ];
}

function parseProfileResponse(raw: string): UserProfile {
  if (!raw) throw new UserProfileBuilderError('profile LLM returned empty content');
  const cleaned = extractFirstJsonObject(raw);
  let parsed: { profile?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { profile?: unknown };
  } catch (err) {
    throw new UserProfileBuilderError(
      `profile LLM returned non-JSON: ${cleaned.slice(0, 200)}`,
      err,
    );
  }
  const profile = typeof parsed.profile === 'string' ? parsed.profile.trim() : '';
  if (!profile || profile.split(/\s+/).filter(Boolean).length < MIN_PROFILE_WORD_COUNT) {
    throw new UserProfileBuilderError('profile too short or missing');
  }
  return { profile };
}

export async function synthesizeUserProfile(
  memoryContents: string[],
  llmClient: LLMProvider = defaultLlm,
): Promise<UserProfile> {
  if (memoryContents.length === 0) {
    throw new UserProfileBuilderError('cannot build profile from zero memories');
  }
  const messages = buildProfileMessages(memoryContents);
  let raw: string;
  try {
    raw = await llmClient.chat(messages, {
      temperature: 0,
      jsonMode: true,
      maxTokens: PROFILE_MAX_TOKENS,
    });
  } catch (err) {
    throw new UserProfileBuilderError(
      `profile LLM call failed: ${(err as Error).message}`,
      err,
    );
  }
  return parseProfileResponse(raw);
}

export async function maybeRebuildProfileForUser(
  deps: MemoryServiceDeps,
  userId: string,
  newlyStoredMemoryIds: string[],
): Promise<boolean> {
  if (!deps.config.userProfileChannelEnabled) return false;
  if (newlyStoredMemoryIds.length < MIN_NEW_MEMORIES_FOR_REBUILD) return false;
  const profileRepo = deps.stores.userProfile;
  if (!profileRepo) return false;
  try {
    const current = await profileRepo.getProfile(userId);
    if (current && Date.now() - current.updated_at.getTime() < MIN_REBUILD_INTERVAL_MS) {
      console.info(`[profile] rebuild debounced for user=${userId} (recent within ${MIN_REBUILD_INTERVAL_MS}ms)`);
      return false;
    }
    const recent = await deps.stores.memory.listMemories(userId, MAX_SOURCES_PER_BUILD, 0);
    if (recent.length === 0) return false;
    const { profile } = await synthesizeUserProfile(recent.map((m) => m.content));
    await profileRepo.upsertProfile(
      userId,
      profile,
      recent.map((m) => m.id),
      current?.updated_at,
    );
    return true;
  } catch (err) {
    console.warn(`[profile] rebuild failed for user=${userId}: ${(err as Error).message}`);
    return false;
  }
}
