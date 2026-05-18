/**
 * Personalized PageRank (PPR) for adaptive link expansion.
 *
 * Replaces fixed-depth BFS link expansion with a principled algorithm that
 * propagates relevance scores through the memory graph. PPR naturally handles
 * variable-hop reasoning: densely-connected subgraphs get deeper traversal,
 * while sparse connections receive less signal.
 *
 * Algorithm: Power iteration on the PPR equation:
 *   r(t+1) = damping * A_norm * r(t) + (1 - damping) * seed
 *
 * where:
 *   seed = initial retrieval scores (normalized to sum=1)
 *   A_norm = column-normalized adjacency matrix from memory_links
 *   damping = probability of following a link (vs teleporting back to seed)
 *
 * Adapted from HippoRAG (NeurIPS 2024) for AtomicMemory's pgvector + link table
 * architecture.
 */

import pg from 'pg';

const DEFAULT_DAMPING = 0.5;
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_TOLERANCE = 1e-6;

export interface PPRConfig {
  /** Probability of following a link vs teleporting back to seed nodes. */
  damping?: number;
  /** Maximum power-iteration rounds. */
  maxIterations?: number;
  /** Convergence threshold (L1 norm of score delta). */
  tolerance?: number;
}

export interface PPRResult {
  /** Memory ID → PPR score, sorted descending. Excludes seed nodes. */
  scores: Map<string, number>;
  /** Number of iterations until convergence. */
  iterations: number;
}

/**
 * Run Personalized PageRank over the memory_links graph.
 *
 * @param pool  - Postgres connection pool
 * @param seedScores - Map of memory ID → relevance score from initial retrieval
 * @param config - PPR tuning parameters
 * @returns PPR scores for all reachable memories (excluding seeds)
 */
/**
 * Run PPR power iteration over an in-memory adjacency list.
 *
 * Exported separately from the DB-loading wrapper so it can be unit-tested
 * without a database connection.
 */
export function runPPR(
  adjacency: Map<string, Set<string>>,
  seedScores: Map<string, number>,
  pprConfig: PPRConfig = {},
): PPRResult {
  if (seedScores.size === 0 || adjacency.size === 0) {
    return { scores: new Map(), iterations: 0 };
  }

  const damping = pprConfig.damping ?? DEFAULT_DAMPING;
  const maxIterations = pprConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = pprConfig.tolerance ?? DEFAULT_TOLERANCE;

  const allNodes = collectNodes(adjacency, seedScores);
  const seed = normalizeSeed(seedScores, allNodes);
  const outDegree = computeOutDegree(adjacency, allNodes);

  const { scores, iterations } = iteratePPR(allNodes, seed, adjacency, outDegree, damping, maxIterations, tolerance);
  return { scores: extractExpansionScores(scores, seedScores), iterations };
}

/** Power iteration loop for PPR convergence. */
function iteratePPR(
  allNodes: Set<string>,
  seed: Map<string, number>,
  adjacency: Map<string, Set<string>>,
  outDegree: Map<string, number>,
  damping: number,
  maxIterations: number,
  tolerance: number,
): { scores: Map<string, number>; iterations: number } {
  let scores = new Map(seed);
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const next = computeNextScores(allNodes, seed, adjacency, outDegree, scores, damping);
    const delta = computeDelta(allNodes, next, scores);
    scores = next;
    if (delta < tolerance) break;
  }
  return { scores, iterations };
}

/** Compute next-step scores from seed teleportation + link propagation. */
function computeNextScores(
  allNodes: Set<string>,
  seed: Map<string, number>,
  adjacency: Map<string, Set<string>>,
  outDegree: Map<string, number>,
  scores: Map<string, number>,
  damping: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const node of allNodes) {
    next.set(node, (1 - damping) * (seed.get(node) ?? 0));
  }
  for (const [src, neighbors] of adjacency) {
    const contribution = damping * (scores.get(src) ?? 0) / (outDegree.get(src) ?? 1);
    for (const neighbor of neighbors) {
      next.set(neighbor, (next.get(neighbor) ?? 0) + contribution);
    }
  }
  return next;
}

/** Compute L1 norm of score delta between iterations. */
function computeDelta(
  allNodes: Set<string>,
  next: Map<string, number>,
  scores: Map<string, number>,
): number {
  let delta = 0;
  for (const node of allNodes) {
    delta += Math.abs((next.get(node) ?? 0) - (scores.get(node) ?? 0));
  }
  return delta;
}

/** Extract non-seed scores above zero for the expansion result. */
function extractExpansionScores(
  scores: Map<string, number>,
  seedScores: Map<string, number>,
): Map<string, number> {
  const seedIds = new Set(seedScores.keys());
  const expansion = new Map<string, number>();
  for (const [id, score] of scores) {
    if (!seedIds.has(id) && score > 0) {
      expansion.set(id, score);
    }
  }
  return expansion;
}

/**
 * Run PPR with adjacency loaded from the database.
 *
 * Loads the 2-hop subgraph around seed nodes from memory_links, then
 * delegates to the pure runPPR function.
 */
export async function personalizedPageRank(
  pool: pg.Pool,
  seedScores: Map<string, number>,
  pprConfig: PPRConfig = {},
): Promise<PPRResult> {
  if (seedScores.size === 0) return { scores: new Map(), iterations: 0 };
  const adjacency = await loadAdjacency(pool, seedScores);
  return runPPR(adjacency, seedScores, pprConfig);
}

/**
 * Load the adjacency list for all nodes reachable within 2 hops from seeds.
 *
 * We limit to 2 hops from seeds to bound the graph size while still allowing
 * PPR to propagate through intermediate nodes. The power iteration handles
 * deeper propagation via the iterative score updates.
 */
async function loadAdjacency(
  pool: pg.Pool,
  seedScores: Map<string, number>,
): Promise<Map<string, Set<string>>> {
  const seedIds = [...seedScores.keys()];
  if (seedIds.length === 0) return new Map();

  const result = await pool.query(
    `WITH seed_links AS (
       SELECT source_id, target_id FROM memory_links
       WHERE source_id = ANY($1) OR target_id = ANY($1)
     ),
     hop1_nodes AS (
       SELECT source_id AS id FROM seed_links
       UNION
       SELECT target_id AS id FROM seed_links
     ),
     hop2_links AS (
       SELECT ml.source_id, ml.target_id FROM memory_links ml
       INNER JOIN hop1_nodes h ON ml.source_id = h.id OR ml.target_id = h.id
     )
     SELECT source_id, target_id FROM seed_links
     UNION
     SELECT source_id, target_id FROM hop2_links`,
    [seedIds],
  );

  const adjacency = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const src = row.source_id as string;
    const tgt = row.target_id as string;

    if (!adjacency.has(src)) adjacency.set(src, new Set());
    adjacency.get(src)!.add(tgt);

    if (!adjacency.has(tgt)) adjacency.set(tgt, new Set());
    adjacency.get(tgt)!.add(src);
  }

  return adjacency;
}

function collectNodes(
  adjacency: Map<string, Set<string>>,
  seedScores: Map<string, number>,
): Set<string> {
  const nodes = new Set<string>();
  for (const id of seedScores.keys()) nodes.add(id);
  for (const [src, neighbors] of adjacency) {
    nodes.add(src);
    for (const neighbor of neighbors) nodes.add(neighbor);
  }
  return nodes;
}

function normalizeSeed(
  seedScores: Map<string, number>,
  allNodes: Set<string>,
): Map<string, number> {
  let total = 0;
  for (const score of seedScores.values()) total += score;
  if (total === 0) total = 1;

  const normalized = new Map<string, number>();
  for (const node of allNodes) {
    normalized.set(node, (seedScores.get(node) ?? 0) / total);
  }
  return normalized;
}

function computeOutDegree(
  adjacency: Map<string, Set<string>>,
  allNodes: Set<string>,
): Map<string, number> {
  const degree = new Map<string, number>();
  for (const node of allNodes) {
    degree.set(node, adjacency.get(node)?.size ?? 0);
  }
  return degree;
}
