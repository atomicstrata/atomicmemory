/**
 * Observation network service — synthesizes entity profiles from scattered
 * facts across the memory store. Part of the 4-network architecture
 * (Hindsight-inspired).
 *
 * Observations are NOT created during ingest. Instead, ingest marks entities
 * as "dirty" in the observation_dirty table. This service processes the
 * dirty queue asynchronously, synthesizing profiles via LLM and storing
 * them as network='observation' memories.
 *
 * Why async: Entity profile synthesis requires reading all facts about an
 * entity and calling an LLM — too expensive for the ingest hot path.
 */

import { ObservationRepository } from '../db/repository-observation.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { embedText } from './embedding.js';
import { llm } from './llm.js';

const SYNTHESIS_PROMPT = `You are a memory synthesis system. Given a set of facts about a subject, produce a comprehensive profile summary.

RULES:
- Synthesize all facts into a coherent profile of the subject
- Include: key attributes, relationships, preferences, and notable activities
- Maintain factual accuracy — do not infer beyond what the facts state
- Write in third person (e.g., "The user works at Google" not "You work at Google")
- Keep the summary concise: 2-4 sentences for simple subjects, up to 8 for complex ones
- Include temporal context when available (e.g., "as of March 2026")

Return ONLY the profile summary text, no formatting or labels.`;

export class ObservationService {
  constructor(
    private observationRepo: ObservationRepository,
    private memoryRepo: MemoryRepository,
  ) {}

  /** Mark entity subjects as needing profile regeneration. Fire-and-forget safe. */
  async markDirty(userId: string, entityNames: string[]): Promise<void> {
    await this.observationRepo.markDirty(userId, entityNames);
  }

  /**
   * Process pending observation regeneration tasks.
   * Call this from a background job or periodic timer.
   */
  async regeneratePending(limit: number = 10): Promise<number> {
    const pending = await this.observationRepo.getPending(limit);
    let processed = 0;

    for (const { userId, subject } of pending) {
      const memories = await this.observationRepo.findMemoriesForSubject(userId, subject);
      if (memories.length === 0) {
        await this.observationRepo.clearDirty(userId, subject);
        continue;
      }

      const factsText = memories.map((m, i) => `[${i + 1}] ${m.content}`).join('\n');
      const prompt = `Subject: ${subject}\n\nFacts:\n${factsText}`;

      const profileText = await llm.chat(
        [
          { role: 'system', content: SYNTHESIS_PROMPT },
          { role: 'user', content: prompt },
        ],
        { temperature: 0, maxTokens: 300 },
      );
      if (!profileText.trim()) {
        await this.observationRepo.clearDirty(userId, subject);
        continue;
      }

      const embedding = await embedText(profileText);

      // Expire previous observation for this subject
      const existingId = await this.observationRepo.findExistingObservation(userId, subject);
      if (existingId) {
        await this.memoryRepo.expireMemory(userId, existingId);
      }

      // Store new observation
      await this.memoryRepo.storeMemory({
        userId,
        content: profileText,
        embedding,
        memoryType: 'semantic',
        importance: 0.8,
        sourceSite: 'observation-service',
        keywords: subject,
        network: 'observation',
        observationSubject: subject,
      });

      await this.observationRepo.clearDirty(userId, subject);
      processed++;
    }

    return processed;
  }
}
