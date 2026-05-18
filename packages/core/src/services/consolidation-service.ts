/**
 * Memory Consolidation Service.
 *
 * Bridges the memory repository and affinity clustering algorithm
 * to identify groups of related memories that are candidates for
 * LLM-based synthesis into abstract memories.
 *
 * Two modes:
 *   - Dry run (findConsolidationCandidates): returns cluster analysis only
 *   - Execute (executeConsolidation): synthesize clusters via LLM, archive originals
 *
 * Triggered on-demand via POST /v1/memories/consolidate or after ingest
 * when memory count exceeds the configured cap.
 */

import { config } from '../config.js';
import type { MemoryStore } from '../db/stores.js';
import type { ClaimStore } from '../db/stores.js';
import type { MemoryRow } from '../db/repository-types.js';
import type { IngestRuntimeConfig } from './memory-service-types.js';
import {
  formClusters,
  type AffinityConfig,
  type ClusterableMemory,
  type MemoryCluster,
} from './affinity-clustering.js';
import { llm } from './llm.js';
import { embedText } from './embedding.js';
import { emitAuditEvent } from './audit-events.js';
import { emitLineageEvent } from './memory-lineage.js';

const DEFAULT_CONSOLIDATION_BATCH_SIZE = 200;
type ConsolidationRuntimeConfig = Pick<IngestRuntimeConfig, 'llmModel'>;

export interface ConsolidationConfig {
  /** Max memories to scan per consolidation run. */
  batchSize: number;
  /** Affinity clustering parameters. */
  affinity: AffinityConfig;
}

export interface ClusterCandidate {
  memberIds: string[];
  memberContents: string[];
  avgAffinity: number;
  memberCount: number;
}

export interface ConsolidationResult {
  memoriesScanned: number;
  clustersFound: number;
  memoriesInClusters: number;
  clusters: ClusterCandidate[];
}

export interface ConsolidationExecutionResult {
  clustersConsolidated: number;
  memoriesArchived: number;
  memoriesCreated: number;
  consolidatedMemoryIds: string[];
}

/**
 * Scan active memories and identify consolidation clusters.
 * Does not modify any data — returns candidates for review or LLM synthesis.
 */
export async function findConsolidationCandidates(
  repo: MemoryStore,
  userId: string,
  consolidationConfig?: Partial<ConsolidationConfig>,
): Promise<ConsolidationResult> {
  const batchSize = consolidationConfig?.batchSize ?? DEFAULT_CONSOLIDATION_BATCH_SIZE;
  const affinityConfig = consolidationConfig?.affinity ?? {
    threshold: config.affinityClusteringThreshold,
    minClusterSize: config.affinityClusteringMinSize,
    beta: config.affinityClusteringBeta,
    temporalLambda: config.affinityClusteringTemporalLambda,
  };

  const memories = await repo.listMemories(userId, batchSize, 0);
  const clusterables = memories.map(toClusterable);
  const clusters = formClusters(clusterables, affinityConfig);

  return {
    memoriesScanned: memories.length,
    clustersFound: clusters.length,
    memoriesInClusters: clusters.reduce((sum, c) => sum + c.members.length, 0),
    clusters: clusters.map(toClusterCandidate),
  };
}

/**
 * Execute consolidation: synthesize each cluster via LLM, store the
 * consolidated memory, and archive the original cluster members.
 */
export async function executeConsolidation(
  repo: MemoryStore,
  claims: ClaimStore,
  userId: string,
  consolidationConfig?: Partial<ConsolidationConfig>,
  runtimeConfig?: ConsolidationRuntimeConfig,
): Promise<ConsolidationExecutionResult> {
  const candidates = await findConsolidationCandidates(repo, userId, consolidationConfig);
  const lineageConfig = runtimeConfig ?? config;

  let memoriesArchived = 0;
  let clustersConsolidated = 0;
  const consolidatedMemoryIds: string[] = [];

  for (const cluster of candidates.clusters) {
    const synthesized = await synthesizeCluster(cluster.memberContents);
    if (!synthesized) continue;

    const maxImportance = Math.max(...cluster.memberContents.map((_, i) => {
      return 0.5; // Default; actual importance comes from DB lookup below
    }));

    const memberMemories = await Promise.all(
      cluster.memberIds.map((id) => repo.getMemory(id, userId)),
    );
    const validMembers = memberMemories.filter((m): m is MemoryRow => m !== null);
    if (validMembers.length < 2) continue;

    const importance = Math.max(...validMembers.map((m) => m.importance));
    const consolidatedImportance = Math.min(1.0, importance + 0.05);
    const sourceSite = validMembers[0].source_site;
    const embedding = await embedText(synthesized);

    const consolidatedId = await repo.storeMemory({
      userId,
      content: synthesized,
      embedding,
      memoryType: 'semantic',
      importance: consolidatedImportance,
      sourceSite,
      metadata: {
        consolidated_from: cluster.memberIds,
        cluster_size: cluster.memberCount,
        avg_affinity: cluster.avgAffinity,
      },
    });

    await emitLineageEvent({ claims, config: lineageConfig }, {
      kind: 'consolidation-add',
      userId,
      memoryId: consolidatedId,
      content: synthesized,
      embedding,
      importance: consolidatedImportance,
      sourceSite,
      mutationReason: `Consolidated ${cluster.memberCount} memories (avg affinity: ${cluster.avgAffinity.toFixed(2)})`,
    });

    for (const member of validMembers) {
      await repo.softDeleteMemory(userId, member.id);
      if (config.auditLoggingEnabled) {
        emitAuditEvent('memory:delete', userId, {
          reason: 'consolidation',
          consolidatedInto: consolidatedId,
        }, { memoryId: member.id });
      }
    }

    consolidatedMemoryIds.push(consolidatedId);
    memoriesArchived += validMembers.length;
    clustersConsolidated++;

    if (config.auditLoggingEnabled) {
      emitAuditEvent('memory:ingest', userId, {
        reason: 'consolidation',
        memberCount: cluster.memberCount,
        avgAffinity: cluster.avgAffinity,
      }, { memoryId: consolidatedId });
    }
  }

  return {
    clustersConsolidated,
    memoriesArchived,
    memoriesCreated: consolidatedMemoryIds.length,
    consolidatedMemoryIds,
  };
}

/**
 * Synthesize a cluster of related memories into a single consolidated memory.
 * Returns the synthesized text, or null if synthesis fails.
 */
export async function synthesizeCluster(memberContents: string[]): Promise<string | null> {
  const prompt = buildSynthesisPrompt(memberContents);
  try {
    const response = await llm.chat([
      { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], { temperature: 0, maxTokens: 500 });
    const synthesized = response.trim();
    if (!synthesized || synthesized.length < 10) return null;
    return synthesized;
  } catch (err) {
    console.error(`Cluster synthesis failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

const SYNTHESIS_SYSTEM_PROMPT = `You consolidate groups of related memory fragments into a single, comprehensive memory.

Rules:
- Preserve ALL distinct facts from the input memories. Do not lose information.
- Merge redundant or overlapping facts into concise statements.
- Use clear, factual language. No hedging ("I think", "maybe").
- Output a single paragraph (2-5 sentences) that captures everything.
- Do not add information not present in the inputs.
- If memories contain temporal updates (e.g., "used to prefer X, now prefers Y"), keep only the latest state unless the history is significant.`;

function buildSynthesisPrompt(memberContents: string[]): string {
  const numbered = memberContents
    .map((content, i) => `${i + 1}. ${content}`)
    .join('\n');
  return `Consolidate these ${memberContents.length} related memories into a single comprehensive memory:\n\n${numbered}\n\nConsolidated memory:`;
}

function toClusterable(row: MemoryRow): ClusterableMemory {
  return {
    id: row.id,
    embedding: row.embedding,
    createdAt: row.created_at,
    content: row.content,
    importance: row.importance,
  };
}

export function toClusterCandidate(cluster: MemoryCluster): ClusterCandidate {
  return {
    memberIds: cluster.members.map((m) => m.id),
    memberContents: cluster.members.map((m) => m.content),
    avgAffinity: cluster.avgAffinity,
    memberCount: cluster.members.length,
  };
}
