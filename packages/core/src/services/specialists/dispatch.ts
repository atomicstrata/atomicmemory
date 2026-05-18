/**
 * Phase 2 specialist dispatcher.
 *
 * After RRF + reranking produce top-K memories, the dispatcher checks
 * specialists in priority order (most-specific pattern first). The first
 * specialist whose shouldInvoke* matches AND whose runSpecialist returns
 * handled=true with a non-empty answer SHORT-CIRCUITS the rest of the
 * pipeline: that answer becomes the LLM-facing answer; shared-spine
 * prompt assembly is skipped.
 *
 * If all specialists return handled=false, the dispatcher returns
 * { handled: false } and the shared spine takes over.
 *
 * Pure DI: every dependency is passed in.
 */

import type { BeliefEdgesRepository } from '../../db/belief-edges-repository.js';
import type { MemoryRow } from '../../db/repository-types.js';
import type { EntityValuesRepository } from '../../db/entity-values-repository.js';
import { runCrSpecialist, shouldInvokeCrSpecialist } from './cr-specialist.js';
import { runMsrSpecialist, shouldInvokeMsrSpecialist } from './msr-specialist.js';
import { runTrSpecialist, shouldInvokeTrSpecialist } from './tr-specialist.js';
import { runIeKuSpecialist, shouldInvokeIeKuSpecialist } from './ie-ku-specialist.js';

export interface DispatchMemoryInput {
  id: string;
  text: string;
  observedAt?: Date;
}

/** Minimal memory-lookup surface needed by the CR specialist. */
export interface MemoryLookup {
  getMemory(id: string, userId?: string): Promise<MemoryRow | null>;
}

export interface SpecialistDispatchDeps {
  memories: ReadonlyArray<DispatchMemoryInput>;
  query: string;
  userId: string;
  model: string;
  /** BeliefEdgesRepository — null when tbcEnabled or phase2 is off. */
  beliefEdges: BeliefEdgesRepository | null;
  /** Memory lookup for fetching contradiction sides not in top-K. */
  memoryRepo: MemoryLookup;
  /** EntityValuesRepository — null when phase2 is off. */
  entityValues: EntityValuesRepository | null;
}

export interface SpecialistDispatchResult {
  handled: boolean;
  answer: string;
  specialist: 'cr' | 'msr' | 'tr' | 'ie_ku' | 'none';
}

/**
 * Detect specialist refusals so the dispatcher abdicates to the shared spine
 * instead of replacing v11's confidence-prefixed retrieval answer with a raw
 * "I cannot find" string. v12 evidence: PHASE2_SPECIALISTS_ENABLED=true cost
 * −0.174 composite because specialists returned `handled=true` with refusal
 * answers, discarding the full injectionText. Fail open: any refusal pattern
 * → treat as not-handled.
 */
const REFUSAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(can(?:not|'t)\s+find|cannot\s+find\s+(?:sufficient|the))/i,
  /\b(?:do(?:es)?\s+not|don'?t)\s+(?:contain|have)\b/i,
  /\bno\s+(?:information|relevant\s+memories|matching\s+facts)\b/i,
  /\bnot\s+(?:enough|sufficient)\s+(?:information|context|memories)/i,
  /\bcontext\s+does\s+not\s+(?:contain|include|specify)\b/i,
  /\bI\s+(?:am\s+unable|don'?t\s+have\s+enough)/i,
  /\binsufficient\s+(?:information|context|memories)/i,
];

function isRefusal(answer: string): boolean {
  if (!answer || answer.trim().length === 0) return true;
  return REFUSAL_PATTERNS.some((p) => p.test(answer));
}

/**
 * Dispatch in priority order. The order matters because some patterns overlap
 * (e.g. "how many days between" matches both MSR's "how many" and TR's
 * "how many days between") — TR is more specific and should win, so TR comes
 * before MSR.
 *
 * Priority: CR → TR → MSR → IE/KU → none (shared spine)
 */
// fallow-ignore-next-line complexity
export async function dispatchSpecialists(
  deps: SpecialistDispatchDeps,
): Promise<SpecialistDispatchResult> {
  // 1. CR — bilateral contradiction
  if (deps.beliefEdges && shouldInvokeCrSpecialist(deps.query)) {
    const cr = await runCrSpecialist({
      memories: deps.memories,
      query: deps.query,
      userId: deps.userId,
      model: deps.model,
      beliefEdges: deps.beliefEdges,
      // MemoryLookup structurally satisfies MemoryRepository's getMemory surface
      memoryRepo: deps.memoryRepo as import('../../db/memory-repository.js').MemoryRepository,
    });
    if (cr.handled && cr.answer && !isRefusal(cr.answer)) {
      return { handled: true, answer: cr.answer, specialist: 'cr' };
    }
  }

  // 2. TR — temporal arithmetic (more specific than MSR; check first)
  if (shouldInvokeTrSpecialist(deps.query)) {
    const tr = await runTrSpecialist({
      memories: deps.memories,
      query: deps.query,
      model: deps.model,
    });
    if (tr.handled && tr.answer && !isRefusal(tr.answer)) {
      return { handled: true, answer: tr.answer, specialist: 'tr' };
    }
  }

  // 3. MSR — multi-session count
  if (shouldInvokeMsrSpecialist(deps.query)) {
    const msr = await runMsrSpecialist({
      memories: deps.memories,
      query: deps.query,
      model: deps.model,
    });
    if (msr.handled && msr.answer && !isRefusal(msr.answer)) {
      return { handled: true, answer: msr.answer, specialist: 'msr' };
    }
  }

  // 4. IE/KU — literal-value SQL lookup
  if (deps.entityValues && shouldInvokeIeKuSpecialist(deps.query)) {
    const ieku = await runIeKuSpecialist({
      values: deps.entityValues,
      query: deps.query,
      userId: deps.userId,
      model: deps.model,
    });
    if (ieku.handled && ieku.answer && !isRefusal(ieku.answer)) {
      return { handled: true, answer: ieku.answer, specialist: 'ie_ku' };
    }
  }

  return { handled: false, answer: '', specialist: 'none' };
}
