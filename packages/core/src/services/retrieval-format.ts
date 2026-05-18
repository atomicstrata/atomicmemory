/**
 * Provenance-first retrieval formatting helpers.
 *
 * Supports two modes:
 *   - Full: each memory's complete content is included (default)
 *   - Staged (L0): only summaries are included, with memory IDs for
 *     on-demand expansion via POST /v1/memories/expand. Reduces injection
 *     tokens by ~80% for typical workloads.
 */

import { config } from '../config.js';
import type { Reflection } from '../db/reflections-repository.js';
import type { EventChain } from './event-chain-detector.js';
import { applyFormatHint, QuestionType } from './answer-format.js';
import type { SearchResult } from '../db/memory-repository.js';
import {
  shouldApplyFormatHint,
  shouldEmitEventChain,
  shouldEmitObservations,
} from './retrieval-channel-rules.js';
import type { ContextTier, TierAssignment } from './tiered-loading.js';
import {
  assignTiers as assignTierBudgets,
  estimateTokens,
  getContentAtTier,
} from './tiered-loading.js';
import { isAnswerBearing, sortBySessionPriority } from './session-packaging.js';
import { deduplicateCompositeMembersHard } from './composite-dedup.js';
import { prefersAbstractAwareRetrieval } from './abstract-query-policy.js';
import type { RetrievalMode } from './memory-service-types.js';
import { escapeXml } from '../xml-escape.js';
import { spansMultipleDates, buildTimelinePack, formatTimelinePack } from './timeline-pack.js';
import { buildTemporalEvidenceBlock } from './temporal-endpoint-evidence.js';
import { preserveQueryTermVisibility, sumAssignmentTokens } from './query-term-visibility.js';
import { formatDateLabel, formatDuration } from './temporal-format.js';

/**
 * Packaging observability signal — records whether and how packaging
 * reordered memories vs. raw retrieval score order. Enables A/B evals
 * to distinguish packaging-caused flips from retrieval noise.
 */
export interface PackagingSignal {
  /** True if packaging changed the memory order from score-descending. */
  reordered: boolean;
  /** Number of distinct episodes (sessions) in the result set. */
  episodeCount: number;
  /** Number of memories classified as answer-bearing by session-packaging heuristics. */
  answerBearingCount: number;
  /** Number of memories classified as context (non-answer-bearing). */
  contextCount: number;
  /** Kendall tau distance: number of pairwise swaps between score order and packaged order (0 = identical). */
  reorderDistance: number;
}

/**
 * Compare score-descending order to the order produced by packaging
 * (session-priority sort, answer-bearing promotion, chronological).
 */
export function computePackagingSignal(memories: SearchResult[]): PackagingSignal {
  if (memories.length === 0) {
    return { reordered: false, episodeCount: 0, answerBearingCount: 0, contextCount: 0, reorderDistance: 0 };
  }

  const scoreOrder = [...memories].sort((a, b) => b.score - a.score).map((m) => m.id);
  const packagedOrder = sortBySessionPriority(memories).map((m) => m.id);

  const reordered = !scoreOrder.every((id, i) => id === packagedOrder[i]);
  const episodeCount = new Set(memories.map((m) => m.episode_id).filter(Boolean)).size;
  const answerBearingCount = memories.filter((m) => isAnswerBearing(m.content)).length;
  const contextCount = memories.length - answerBearingCount;
  const reorderDistance = kendallTauDistance(scoreOrder, packagedOrder);

  return { reordered, episodeCount, answerBearingCount, contextCount, reorderDistance };
}

/** Count pairwise inversions between two orderings of the same IDs. */
function kendallTauDistance(orderA: string[], orderB: string[]): number {
  const posB = new Map(orderB.map((id, i) => [id, i]));
  let inversions = 0;
  for (let i = 0; i < orderA.length; i++) {
    for (let j = i + 1; j < orderA.length; j++) {
      const posI = posB.get(orderA[i]) ?? 0;
      const posJ = posB.get(orderA[j]) ?? 0;
      if (posI > posJ) inversions++;
    }
  }
  return inversions;
}

export interface RetrievalCitation {
  memory_id: string;
  source_site: string;
  created_at: string;
  importance: number;
}

/**
 * Recap row promoted into the injection's `## EPISODES` channel.
 * One element per recap; `topic` becomes the section header and
 * `narrative` is the synthesized recap text.
 */
export interface EpisodeForInjection {
  topic: string;
  narrative: string;
}

export interface RetrievalFormatOptions {
  stagedLoadingEnabled?: boolean;
  userProfileText?: string;
  episodes?: EpisodeForInjection[];
  entityFacts?: import('./episode-fetcher.js').EntityFactForInjection[];
}

function buildEpisodesChannel(episodes: EpisodeForInjection[]): string {
  const sections = episodes.map((ep, i) =>
    `### Episode ${i + 1}: ${ep.topic}\n${ep.narrative}`,
  );
  return `## EPISODES\n${sections.join('\n\n')}`;
}

function buildFactsChannel(facts: import('./episode-fetcher.js').EntityFactForInjection[]): string {
  if (facts.length === 0) return '';
  const lines = facts
    .map((f) => `- (${f.entity}.${f.attribute} = ${f.value}) [as of ${f.observedAt.toISOString().slice(0, 10)}]`)
    .join('\n');
  return `## FACTS\n${lines}`;
}

export function buildCitations(memories: SearchResult[]): RetrievalCitation[] {
  return memories.map((memory) => ({
    memory_id: memory.id,
    source_site: memory.source_site,
    created_at: memory.created_at.toISOString(),
    importance: memory.importance,
  }));
}

/**
 * Effective timestamp for packaging. When enabled, observed_at represents
 * the conversation-time ordering while created_at remains the ingest time.
 */
function pickPackagingDate(memory: SearchResult): Date {
  if (config.packagingUseObservedAt && memory.observed_at) return memory.observed_at;
  return memory.created_at;
}

/** Sort memories by effective packaging date ascending. */
function sortChronologically(memories: SearchResult[]): SearchResult[] {
  return [...memories].sort(
    (a, b) => pickPackagingDate(a).getTime() - pickPackagingDate(b).getTime(),
  );
}

/**
 * A2 injection: session-priority sort with answer-bearing tags, grouped by
 * namespace. Flat subject headers for all groups (no timeline packs).
 * Used by the packaging ablation to isolate session-pack effects from
 * timeline-pack effects.
 */
function formatSessionPackInjection(memories: SearchResult[]): string {
  if (memories.length === 0) return '';
  const groups = groupByNamespace(memories);
  const sections = [...groups.entries()].map(([ns, groupMemories]) =>
    formatSubjectSection(ns, groupMemories),
  );
  return appendTemporalSummary(sections, memories);
}

/** Simple dash-delimited injection format (no XML). */
export function formatSimpleInjection(memories: SearchResult[]): string {
  if (memories.length === 0) return '';
  const groups = groupByNamespace(memories);
  const sections = [...groups.entries()].map(([ns, groupMemories]) => {
    if (spansMultipleDates(groupMemories)) {
      const pack = buildTimelinePack(ns, groupMemories);
      return formatTimelinePack(pack);
    }
    return formatSubjectSection(ns, groupMemories);
  });
  return appendTemporalSummary(sections, memories);
}

/** Group memories by namespace for subject-partitioned injection. */
function groupByNamespace(memories: SearchResult[]): Map<string, SearchResult[]> {
  const groups = new Map<string, SearchResult[]>();
  for (const m of memories) {
    const ns = m.namespace || 'general';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(m);
  }
  return groups;
}

/** Format a single namespace group as a subject section with answer/context labels. */
function formatSubjectSection(ns: string, groupMemories: SearchResult[]): string {
  const sorted = sortBySessionPriority(groupMemories);
  const lines = sorted.map((m) => {
    const date = pickPackagingDate(m).toISOString().slice(0, 10);
    const kind = isAnswerBearing(m.content) ? 'answer' : 'context';
    return `- [${date}] [${kind}] ${m.content}`;
  }).join('\n');
  return `### Subject: ${ns}\n${lines}`;
}

/** Join sections and append temporal summary if present. */
function appendTemporalSummary(sections: string[], memories: SearchResult[]): string {
  const sortedAll = sortChronologically(memories);
  const timeline = buildTemporalSummary(sortedAll);
  const mainContent = sections.join('\n\n');
  return timeline ? `${mainContent}\n\n${timeline}` : mainContent;
}

/**
 * Build a timeline summary with computed time gaps between distinct dates.
 * Helps weak LLMs answer temporal questions without doing date arithmetic.
 */
function buildTemporalSummary(sortedMemories: SearchResult[]): string {
  const uniqueDates = getUniqueDates(sortedMemories);
  if (uniqueDates.length < 2) return '';

  const gaps: string[] = [];
  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = uniqueDates[i - 1];
    const curr = uniqueDates[i];
    const diffMs = curr.getTime() - prev.getTime();
    const diffDays = Math.round(diffMs / 86400000);
    if (diffDays === 0) continue;
    const duration = formatDuration(diffDays);
    gaps.push(`- ${formatDateLabel(prev)} → ${formatDateLabel(curr)}: ${duration}`);
  }

  if (gaps.length === 0) return '';

  const first = uniqueDates[0];
  const last = uniqueDates[uniqueDates.length - 1];
  const totalDays = Math.round((last.getTime() - first.getTime()) / 86400000);
  const totalLine = `Total span: ${formatDateLabel(first)} to ${formatDateLabel(last)} (${formatDuration(totalDays)})`;
  const evidenceLines = buildTemporalEvidenceLines(sortedMemories, uniqueDates);
  const evidenceBlock = evidenceLines.length > 0
    ? `\nKey temporal evidence:\n${evidenceLines.join('\n')}`
    : '';

  return `Timeline:\n${gaps.join('\n')}\n${totalLine}${evidenceBlock}`;
}

function getUniqueDates(memories: SearchResult[]): Date[] {
  const seen = new Set<string>();
  const dates: Date[] = [];
  for (const m of memories) {
    const ts = pickPackagingDate(m);
    const key = ts.toISOString().slice(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      dates.push(ts);
    }
  }
  return dates;
}

function buildTemporalEvidenceLines(
  memories: SearchResult[],
  dates: Date[],
): string[] {
  return dates
    .slice(0, 4)
    .map((date) => buildTemporalEvidenceLine(memories, date))
    .filter((line): line is string => line !== null);
}

function buildTemporalEvidenceLine(memories: SearchResult[], date: Date): string | null {
  const key = formatDateLabel(date);
  const sameDate = memories.filter((memory) => formatDateLabel(pickPackagingDate(memory)) === key);
  const selected = sameDate.find((memory) => isAnswerBearing(memory.content)) ?? sameDate[0];
  if (!selected) return null;
  return `- ${key}: ${truncateTemporalEvidence(selected.content)}`;
}

function truncateTemporalEvidence(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

const MIN_AFTER_FILTER = 3;
const DEDUP_FINGERPRINT_PREFIX = 80;

function answerOnlyFilter(memories: SearchResult[]): SearchResult[] {
  if (!config.answerOnlyRetrievalFilter) return memories;
  const filtered = memories.filter((memory) => isAnswerBearing(memory.content));
  return filtered.length >= MIN_AFTER_FILTER ? filtered : memories;
}

function contentFingerprint(content: string): string {
  return content.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, DEDUP_FINGERPRINT_PREFIX);
}

function dedupNearDuplicates(memories: SearchResult[]): SearchResult[] {
  if (!config.retrievalDedupEnabled) return memories;
  const seen = new Set<string>();
  const result: SearchResult[] = [];
  for (const memory of memories) {
    const fingerprint = contentFingerprint(memory.content);
    if (fingerprint.length === 0) {
      result.push(memory);
      continue;
    }
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(memory);
  }
  return result.length >= MIN_AFTER_FILTER ? result : memories;
}

export function formatInjection(
  memories: SearchResult[],
  options: RetrievalFormatOptions = {},
): string {
  const filteredMemories = dedupNearDuplicates(answerOnlyFilter(memories));
  const hasProfile = !!options.userProfileText && options.userProfileText.trim().length > 0;
  const hasEpisodes = !!options.episodes && options.episodes.length > 0;
  const hasFacts = !!options.entityFacts && options.entityFacts.length > 0;
  if (filteredMemories.length === 0 && !hasProfile && !hasEpisodes && !hasFacts) return '';
  const stagedLoadingEnabled = options.stagedLoadingEnabled ?? config.stagedLoadingEnabled;
  const profileBlock = hasProfile ? `## USER PROFILE\n${options.userProfileText}\n\n` : '';
  const factsBlock = hasFacts ? `${buildFactsChannel(options.entityFacts!)}\n\n` : '';
  const episodesBlock = hasEpisodes ? `${buildEpisodesChannel(options.episodes!)}\n\n` : '';
  const body = filteredMemories.length === 0
    ? ''
    : (stagedLoadingEnabled ? formatStagedInjection(filteredMemories) : formatFullInjection(filteredMemories));
  return `${profileBlock}${factsBlock}${episodesBlock}${body}`;
}

function formatFullInjection(memories: SearchResult[]): string {
  const sorted = sortChronologically(memories);
  const lines = sorted.map((memory, index) => formatFullLine(memory, index));
  const body = `<atomicmem_context count="${memories.length}">\n${lines.join('\n')}\n</atomicmem_context>`;
  const timeline = config.timelineChannelEnabled ? buildTimelineChannel(memories) : '';
  return timeline ? `${timeline}\n\n${body}` : body;
}

function buildTimelineChannel(memories: SearchResult[]): string {
  const dates = memories
    .map((m) => m.observed_at)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return '';
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const d of dates) {
    const key = d.toISOString().slice(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(key);
    }
  }
  const lines = unique.map((d) => `- ${d}`).join('\n');
  return `## TIMELINE\n${lines}`;
}

function formatStagedInjection(memories: SearchResult[]): string {
  const sorted = sortChronologically(memories);
  const lines = sorted.map((memory, index) => formatStagedLine(memory, index));
  const ids = sorted.map((m) => m.id).join(',');
  return [
    `<atomicmem_context count="${memories.length}" mode="staged" expand_ids="${ids}">`,
    lines.join('\n'),
    '<expand_hint>To see full content for any memory, request expansion by ID.</expand_hint>',
    '</atomicmem_context>',
  ].join('\n');
}

function formatFullLine(memory: SearchResult, index: number): string {
  const attrs = buildCommonAttrs(memory, index);
  return `<memory ${attrs}>\n${escapeXml(memory.content)}\n</memory>`;
}

function formatStagedLine(memory: SearchResult, index: number): string {
  const attrs = buildCommonAttrs(memory, index);
  const summary = memory.summary || truncateContent(memory.content);
  return `<memory ${attrs} staged="true">\n${escapeXml(summary)}\n</memory>`;
}

function buildCommonAttrs(memory: SearchResult, index: number): string {
  const date = pickPackagingDate(memory);
  const attrs = [
    `index="${index + 1}"`,
    `source="${escapeXml(memory.source_site)}"`,
    `memory_id="${memory.id}"`,
    `created_at="${memory.created_at.toISOString()}"`,
  ];
  if (
    config.packagingDualDate
    && memory.observed_at
    && memory.observed_at.getTime() !== memory.created_at.getTime()
  ) {
    attrs.push(`observed_at="${memory.observed_at.toISOString()}"`);
  }
  attrs.push(
    `importance="${memory.importance.toFixed(1)}"`,
    `similarity="${memory.similarity.toFixed(2)}"`,
    `score="${memory.score.toFixed(2)}"`,
    `age="${formatAge(date)}"`,
  );
  return attrs.join(' ');
}

const STAGED_TRUNCATE_LENGTH = 60;

/** Fallback when no summary is stored: first 60 chars + ellipsis. */
function truncateContent(content: string): string {
  if (content.length <= STAGED_TRUNCATE_LENGTH) return content;
  return content.slice(0, STAGED_TRUNCATE_LENGTH) + '...';
}


export interface FormatTieredOptions {
  /**
   * When `false`, the renderer omits the trailing temporal evidence
   * block / timeline summary entirely. The caller is responsible for
   * setting this when the budget can't fit the extra-block tokens
   * after the included memories are accounted for — without this
   * escape hatch, the rendered injection would silently exceed the
   * caller's `tokenBudget`. Default `true` preserves prior behavior.
   */
  includeExtraBlock?: boolean;
}

/**
 * Format injection using tier assignments from the budget allocator.
 * Uses a compact line-oriented format so tier metadata does not erase
 * the token savings from L0/L1 compression.
 *
 * Iteration is driven off `assignments`: the rendered output contains
 * exactly the memories named by the assignment list, in chronological
 * order. Memories present in the input but missing from `assignments`
 * are not rendered — that's how excluded-by-budget memories stay
 * absent from the package. Throws when an assignment references a
 * memory id that isn't in the input list (caller bug).
 */
export function formatTieredInjection(
  memories: SearchResult[],
  assignments: TierAssignment[],
  query = '',
  options: FormatTieredOptions = {},
): string {
  if (assignments.length === 0) return '';
  const memoryById = new Map(memories.map((m) => [m.id, m]));
  const tierById = new Map(assignments.map((a) => [a.memoryId, a.tier]));
  const assignedMemories = assignments.map((a) => {
    const memory = memoryById.get(a.memoryId);
    if (!memory) {
      throw new Error(`formatTieredInjection: assignment references missing memory id "${a.memoryId}"`);
    }
    return memory;
  });
  const sorted = sortChronologically(assignedMemories);
  const lines = sorted.map((memory) => formatTieredLine(memory, tierById.get(memory.id)!));
  const expandableIds = assignments
    .filter((a) => a.tier !== 'L2')
    .map((a) => a.memoryId)
    .join(',');
  const sections = expandableIds
    ? [lines.join('\n'), `Expandable IDs: ${expandableIds}`]
    : [lines.join('\n')];
  if (options.includeExtraBlock === false) return sections.join('\n\n');
  const temporalEvidenceBlock = buildTemporalEvidenceBlock(sorted, query);
  if (temporalEvidenceBlock) {
    return [...sections, temporalEvidenceBlock].join('\n\n');
  }
  return appendTemporalSummary(sections, sorted);
}

function buildEventChainChannel(chains: EventChain[] | undefined, enabled: boolean): string {
  if (!enabled || !chains || chains.length === 0) return '';
  const top = chains[0];
  const lines = top.members.map((m, i) => {
    const date = m.observedAt.toISOString().slice(0, 10);
    return `${i + 1}) [${date}] ${m.text}`;
  });
  return `## EVENT_CHAIN [entity: ${top.entity}] (chronological)\n${lines.join('\n')}`;
}

function buildObservationsChannel(
  reflections: readonly Reflection[] | undefined,
): string {
  if (!reflections || reflections.length === 0) return '';
  const lines = reflections.map((r) => {
    const evidence = r.evidenceMemoryIds.join(', ');
    return `- [${r.observationType}] ${r.observation}\n  evidence: ${evidence}`;
  });
  return `## OBSERVATIONS\n${lines.join('\n')}\n\n`;
}

function formatTieredLine(memory: SearchResult, tier: ContextTier): string {
  const date = pickPackagingDate(memory).toISOString().slice(0, 10);
  const kind = memory.memory_type === 'composite' ? 'composite' : 'atomic';
  const content = getContentAtTier(memory, tier);
  return `- [${date}] [${tier}] [${kind}] ${content}`;
}

function formatAge(date: Date): string {
  const hours = (Date.now() - date.getTime()) / 3600000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

const UNBOUNDED_INJECTION_TOKEN_BUDGET = Number.POSITIVE_INFINITY;

export interface InjectionBuildResult {
  injectionText: string;
  tierAssignments?: TierAssignment[];
  expandIds?: string[];
  estimatedContextTokens?: number;
  /**
   * True when the requested token budget changed the package content
   * relative to the unconstrained tiered package — either eligible
   * memories were omitted because their L0 representation did not fit,
   * or eligible memories were kept at a reduced tier solely because
   * the budget prevented richer eligible content (including
   * query-term-revealing upgrades). Quota-driven demotion (e.g.
   * MAX_L2_MEMORIES) is packaging policy and is NOT flagged.
   */
  budgetConstrained: boolean;
  /**
   * Memories that actually contributed to the rendered package.
   * In tiered mode this is `deduplicateCompositeMembersHard(memories) - excluded`.
   * In flat mode this equals the input memories. Downstream consumers
   * (response.memories, citations, side effects) should use this set
   * so what they see matches what was injected.
   */
  includedMemories: SearchResult[];
}

/**
 * Build injection text from search results, optionally using tiered packaging.
 * Flat mode returns the existing chronological format.
 * Tiered mode assigns L0/L1/L2 tiers under the caller's token budget.
 * When no token budget is provided, tiered packaging is unbounded:
 * quotas still shape rich-detail tiers, but budget_constrained remains
 * false because no caller budget was applied.
 */
export function buildInjection(
  memories: SearchResult[],
  query: string,
  mode: RetrievalMode,
  tokenBudget?: number,
  userProfileText?: string,
  episodes?: EpisodeForInjection[],
  entityFacts?: import('./episode-fetcher.js').EntityFactForInjection[],
  chains?: EventChain[],
  reflections?: readonly Reflection[],
  questionType: QuestionType = QuestionType.OTHER,
): InjectionBuildResult {
  const prefix = buildPromptChannelPrefix(
    userProfileText,
    episodes,
    entityFacts,
    chains,
    reflections,
    questionType,
  );
  const applyHint = shouldApplyFormatHint(questionType) && config.answerFormatAlignmentEnabled;
  if (memories.length === 0) {
    const text = applyHint && prefix ? applyFormatHint(prefix, query, true) : prefix;
    return { injectionText: text, budgetConstrained: false, includedMemories: [] };
  }
  if (mode === 'flat') {
    const body = `${prefix}${formatSimpleInjection(memories)}`;
    return {
      injectionText: applyHint ? applyFormatHint(body, query, true) : body,
      budgetConstrained: false,
      includedMemories: memories,
    };
  }
  const tiered = buildTieredInjection(memories, query, mode, tokenBudget);
  const body = `${prefix}${tiered.injectionText}`;
  return {
    ...tiered,
    injectionText: applyHint ? applyFormatHint(body, query, true) : body,
  };
}

function buildPromptChannelPrefix(
  userProfileText: string | undefined,
  episodes: EpisodeForInjection[] | undefined,
  entityFacts: import('./episode-fetcher.js').EntityFactForInjection[] | undefined,
  chains: EventChain[] | undefined,
  reflections: readonly Reflection[] | undefined,
  questionType: QuestionType,
): string {
  const profile = userProfileText?.trim();
  const profileBlock = profile ? `## USER PROFILE\n${profile}\n\n` : '';
  const factsBlock = entityFacts && entityFacts.length > 0 ? `${buildFactsChannel(entityFacts)}\n\n` : '';
  const episodesBlock = episodes && episodes.length > 0 ? `${buildEpisodesChannel(episodes)}\n\n` : '';
  const observationsBlock = shouldEmitObservations(questionType)
    ? buildObservationsChannel(reflections)
    : '';
  const rawChainSection = shouldEmitEventChain(questionType)
    ? buildEventChainChannel(chains, config.eventChainPackagingEnabled)
    : '';
  const eventChainBlock = rawChainSection ? `${rawChainSection}\n\n` : '';
  return `${profileBlock}${factsBlock}${episodesBlock}${observationsBlock}${eventChainBlock}`;
}

/**
 * Tiered-mode package: dedupe composites, reserve tokens for the
 * "extra block" the renderer will append (temporal evidence on
 * temporal queries, timeline summary otherwise — see
 * `computeRenderedExtraTokens`) using a conservative upper-bound from
 * the full deduplicated set, capped so the highest-ranked (top of
 * list) memory's L0 always fits — see `computeExtraBlockReservation`.
 * L0-fit + tier-assign on whatever survives. If the included
 * memories' rendered tokens plus the actual extra block would
 * overflow the budget, drop the extra block and rerun allocation
 * with the full budget so the reserved tokens aren't wasted. Render
 * and report from the surviving subset only.
 */
function buildTieredInjection(
  memories: SearchResult[],
  query: string,
  mode: RetrievalMode,
  tokenBudget: number | undefined,
): InjectionBuildResult {
  const deduplicated = deduplicateCompositeMembersHard(memories);
  const budget = tokenBudget ?? UNBOUNDED_INJECTION_TOKEN_BUDGET;
  const forceRichTopHit = prefersAbstractAwareRetrieval(mode, query);

  // First pass: reserve budget for the extra block.
  const reservation = computeExtraBlockReservation(deduplicated, query, budget);
  let pass = runTieredPass(deduplicated, query, reservation.assignmentBudget, forceRichTopHit);
  let extraBlockTokens = computeRenderedExtraTokens(pass.tier.includedMemories, query);
  let extraBlockOmitted = false;

  // If the extra block won't fit alongside the included memories, the
  // reserved tokens are now wasted: rerun allocation against the FULL
  // budget and render without the extra block. Without this second
  // pass, the reservation cap silently shrinks the package even
  // though the omitted block freed those tokens. Deterministic — no
  // iteration, no timing.
  if (pass.sumAssignments + extraBlockTokens > budget) {
    extraBlockOmitted = true;
    pass = runTieredPass(deduplicated, query, budget, forceRichTopHit);
    extraBlockTokens = 0;
  }

  if (pass.tier.includedMemories.length === 0) {
    return {
      injectionText: '',
      budgetConstrained: pass.tier.excludedMemoryIds.length > 0 || reservation.reservationCapped,
      includedMemories: [],
    };
  }

  const expandIds = pass.visibility.assignments.filter((a) => a.tier !== 'L2').map((a) => a.memoryId);
  return {
    injectionText: formatTieredInjection(pass.tier.includedMemories, pass.visibility.assignments, query, { includeExtraBlock: !extraBlockOmitted }),
    tierAssignments: pass.visibility.assignments,
    expandIds: expandIds.length > 0 ? expandIds : undefined,
    estimatedContextTokens: pass.sumAssignments + extraBlockTokens,
    budgetConstrained: computeBudgetConstrained(pass.tier, pass.visibility, reservation.reservationCapped, extraBlockOmitted),
    includedMemories: pass.tier.includedMemories,
  };
}

interface TieredPass {
  tier: ReturnType<typeof assignTierBudgets>;
  visibility: ReturnType<typeof preserveQueryTermVisibility>;
  sumAssignments: number;
}

/**
 * Run one allocation pass: tier-assign within `assignmentBudget`,
 * then run query-term-visibility upgrades within the same budget.
 * Returns empty-but-shaped state when no memory survives L0-fit so
 * the caller can branch on `tier.includedMemories.length` without
 * defensive nullability checks.
 */
function runTieredPass(
  deduplicated: SearchResult[],
  query: string,
  assignmentBudget: number,
  forceRichTopHit: boolean,
): TieredPass {
  const tier = assignTierBudgets(deduplicated, assignmentBudget, { forceRichTopHit });
  if (tier.includedMemories.length === 0) {
    return { tier, visibility: { assignments: [], budgetBlockedVisibilityIds: [] }, sumAssignments: 0 };
  }
  const visibility = preserveQueryTermVisibility(tier.includedMemories, tier.assignments, query, assignmentBudget);
  return { tier, visibility, sumAssignments: sumAssignmentTokens(visibility.assignments) };
}

interface ExtraBlockReservation {
  assignmentBudget: number;
  reservationCapped: boolean;
}

/**
 * Reserve tokens for whatever extra block `formatTieredInjection`
 * will append (temporal evidence OR timeline summary), capped so the
 * highest-ranked memory's L0 representation can still fit. The cap is
 * rank-aware (top of the list), not min-anywhere, because
 * `selectL0Fit` does strict tail exclusion: a memory only enters the
 * included set if every higher-ranked memory has already fit. A min-
 * anywhere cap would leave room for a smaller lower-ranked memory
 * while excluding the top, blanking the rendered package. When
 * capping actually trims the desired reservation, surface that as a
 * budget-constrained signal.
 */
function computeExtraBlockReservation(
  deduplicated: SearchResult[],
  query: string,
  budget: number,
): ExtraBlockReservation {
  const desired = computeRenderedExtraTokens(deduplicated, query);
  if (desired === 0) {
    return { assignmentBudget: budget, reservationCapped: false };
  }
  const topL0 = deduplicated.length === 0
    ? 0
    : estimateTokens(getContentAtTier(deduplicated[0], 'L0'));
  const maxReservation = Math.max(0, budget - topL0);
  const reservation = Math.min(desired, maxReservation);
  return {
    assignmentBudget: Math.max(0, budget - reservation),
    reservationCapped: reservation < desired,
  };
}

/**
 * Token cost of whatever extra block `formatTieredInjection` will
 * append for these memories + this query. Mirrors the renderer's
 * branch: try `buildTemporalEvidenceBlock` first; if empty, fall
 * through to the timeline summary that `appendTemporalSummary`
 * would emit. Keeping this in lockstep with the renderer is what
 * guarantees `estimatedContextTokens` matches the rendered text —
 * a previous version only counted the endpoint block, missing
 * timeline tokens on non-temporal queries with multi-date memories.
 */
function computeRenderedExtraTokens(memories: SearchResult[], query: string): number {
  if (memories.length === 0) return 0;
  const sorted = sortChronologically(memories);
  const endpoint = buildTemporalEvidenceBlock(sorted, query);
  if (endpoint) return estimateTokens(endpoint);
  const timeline = buildTemporalSummary(sorted);
  return timeline ? estimateTokens(timeline) : 0;
}

function computeBudgetConstrained(
  tier: ReturnType<typeof assignTierBudgets>,
  visibility: ReturnType<typeof preserveQueryTermVisibility>,
  reservationCapped: boolean,
  extraBlockOmitted: boolean,
): boolean {
  return (
    reservationCapped ||
    extraBlockOmitted ||
    tier.excludedMemoryIds.length > 0 ||
    tier.budgetLimitedPromotionIds.length > 0 ||
    visibility.budgetBlockedVisibilityIds.length > 0
  );
}
