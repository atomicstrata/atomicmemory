/**
 * Consensus extraction — stabilizes LLM fact extraction by running
 * extractFacts() multiple times and keeping only facts that appear
 * consistently across runs.
 *
 * For each run, facts are compared by semantic similarity. A fact is
 * "stable" if it appears (with similarity >= threshold) in at least
 * ceil(N/2) of N runs. Unstable facts are discarded.
 *
 * This reduces variance from LLM non-determinism at the cost of
 * N× extraction API calls.
 */

import { extractFacts, type ExtractedFact } from './extraction.js';
import { cachedExtractFacts } from './extraction-cache.js';
import { chunkedExtractFacts } from './chunked-extraction.js';
import { cosineSimilarity, embedText } from './embedding.js';
import { classifyNetwork } from './memory-network.js';
import { mergeQuotedEntityFacts } from './quoted-entity-extraction.js';

const SIMILARITY_THRESHOLD = 0.90;

/**
 * Config subset consumed by consensusExtractFacts. Kept narrow so callers
 * only need to thread through the fields the function actually reads —
 * a `Pick<IngestRuntimeConfig, ...>` of the deps.config bundle.
 */
export interface ConsensusExtractionConfig {
  consensusExtractionEnabled: boolean;
  consensusExtractionRuns: number;
  chunkedExtractionEnabled: boolean;
  chunkedExtractionFallbackEnabled: boolean;
  chunkSizeTurns: number;
  chunkOverlapTurns: number;
  extractionCacheEnabled: boolean;
  observationDateExtractionEnabled: boolean;
  quotedEntityExtractionEnabled: boolean;
}

interface FactWithEmbedding {
  fact: ExtractedFact;
  embedding: number[];
}

/**
 * Run extraction N times and return facts based on mode:
 * - "consensus" (default): Keep only facts that appear in majority of runs.
 * - "union": Keep all unique facts found across all runs (improves recall).
 * Falls back to single extraction when consensus is disabled.
 *
 * Config is passed explicitly — consumers thread their `deps.config`
 * through. This module no longer reads the module-level config singleton.
 */
export async function consensusExtractFacts(
  conversationText: string,
  config: ConsensusExtractionConfig,
): Promise<ExtractedFact[]> {
  if (!config.consensusExtractionEnabled) {
    const options = buildExtractionOptions(config);
    const facts = await extractOnce(conversationText, options, config);
    return applyOptionalQuotedEntityExtraction(facts, conversationText, config);
  }

  const allRunFacts = await runMultipleExtractions(conversationText, config);
  const mode = (process.env.CONSENSUS_MODE || 'consensus').toLowerCase();

  if (mode === 'union') {
    const unique = await deduplicateFacts(allRunFacts.flat());
    return applyNetworkClassification(applyOptionalQuotedEntityExtraction(unique, conversationText, config));
  }

  const stableFacts = await filterByMajorityVote(allRunFacts);
  return applyNetworkClassification(applyOptionalQuotedEntityExtraction(stableFacts, conversationText, config));
}

function applyOptionalQuotedEntityExtraction(
  facts: ExtractedFact[],
  conversationText: string,
  config: Pick<ConsensusExtractionConfig, 'quotedEntityExtractionEnabled'>,
): ExtractedFact[] {
  return config.quotedEntityExtractionEnabled
    ? mergeQuotedEntityFacts(facts, conversationText)
    : facts;
}

/** Run extractFacts() N times to get independent LLM samples. */
async function runMultipleExtractions(
  conversationText: string,
  config: Pick<ConsensusExtractionConfig, 'consensusExtractionRuns' | 'observationDateExtractionEnabled'>,
): Promise<ExtractedFact[][]> {
  const allRunFacts: ExtractedFact[][] = [];
  const options = buildExtractionOptions(config);
  for (let i = 0; i < config.consensusExtractionRuns; i++) {
    allRunFacts.push(await extractFacts(conversationText, options));
  }
  return allRunFacts;
}

function buildExtractionOptions(
  config: Pick<ConsensusExtractionConfig, 'observationDateExtractionEnabled'>,
) {
  return {
    observationDateExtractionEnabled: config.observationDateExtractionEnabled,
  };
}

function buildChunkingConfig(
  config: Pick<ConsensusExtractionConfig, 'chunkSizeTurns' | 'chunkOverlapTurns' | 'extractionCacheEnabled'>,
) {
  return {
    chunkSizeTurns: config.chunkSizeTurns,
    chunkOverlapTurns: config.chunkOverlapTurns,
    extractionCacheEnabled: config.extractionCacheEnabled,
  };
}

async function extractOnce(
  conversationText: string,
  options: ReturnType<typeof buildExtractionOptions>,
  config: Pick<ConsensusExtractionConfig,
    | 'chunkedExtractionEnabled'
    | 'chunkedExtractionFallbackEnabled'
    | 'chunkSizeTurns'
    | 'chunkOverlapTurns'
    | 'extractionCacheEnabled'
  >,
): Promise<ExtractedFact[]> {
  if (config.chunkedExtractionEnabled) {
    return chunkedExtractFacts(conversationText, options, buildChunkingConfig(config));
  }

  // Branch on the per-request runtime config rather than the singleton.
  // cachedExtractFacts internally checks the singleton; if a benchmark sets
  // config_override.extractionCacheEnabled=false but the singleton is true,
  // routing through cachedExtractFacts would silently cache anyway.
  const facts = config.extractionCacheEnabled
    ? await cachedExtractFacts(conversationText, options)
    : await extractFacts(conversationText, options);
  if (!shouldUseChunkedFallback(conversationText, facts, config)) return facts;
  return chunkedExtractFacts(conversationText, options, buildChunkingConfig(config));
}

function shouldUseChunkedFallback(
  conversationText: string,
  facts: ExtractedFact[],
  config: Pick<ConsensusExtractionConfig, 'chunkedExtractionFallbackEnabled' | 'chunkSizeTurns'>,
): boolean {
  return config.chunkedExtractionFallbackEnabled
    && facts.length === 0
    && countConversationTurns(conversationText) > config.chunkSizeTurns;
}

function countConversationTurns(conversationText: string): number {
  return conversationText
    .split('\n')
    .filter((line) => /^\w[\w\s]*:/.test(line.trim()))
    .length;
}

/** Keep only facts from run[0] that appear in a majority of all runs. */
async function filterByMajorityVote(
  allRunFacts: ExtractedFact[][],
): Promise<ExtractedFact[]> {
  const referenceFacts = allRunFacts[0];
  if (referenceFacts.length === 0) return [];

  const majority = Math.ceil(allRunFacts.length / 2);
  const refWithEmbeddings = await embedFacts(referenceFacts);
  const otherRunEmbeddings = await Promise.all(
    allRunFacts.slice(1).map((facts) => embedFacts(facts)),
  );

  return refWithEmbeddings
    .filter((ref) => countMatches(ref, otherRunEmbeddings) + 1 >= majority)
    .map((ref) => ref.fact);
}

/** Embed all facts in a batch. */
async function embedFacts(facts: ExtractedFact[]): Promise<FactWithEmbedding[]> {
  return Promise.all(
    facts.map(async (fact) => ({ fact, embedding: await embedText(fact.fact) })),
  );
}

/** Count how many other runs contain a similar fact. */
function countMatches(
  ref: FactWithEmbedding,
  otherRuns: FactWithEmbedding[][],
): number {
  let count = 0;
  for (const run of otherRuns) {
    const hasMatch = run.some(
      (other) => cosineSimilarity(ref.embedding, other.embedding) >= SIMILARITY_THRESHOLD,
    );
    if (hasMatch) count++;
  }
  return count;
}

/** Deduplicate facts using embedding similarity. */
async function deduplicateFacts(facts: ExtractedFact[]): Promise<ExtractedFact[]> {
  if (facts.length <= 1) return facts;
  const withEmb = await Promise.all(facts.map(async (f) => ({ fact: f, embedding: await embedText(f.fact) })));
  const kept: boolean[] = new Array(facts.length).fill(true);
  for (let i = 0; i < withEmb.length; i++) {
    if (!kept[i]) continue;
    for (let j = i + 1; j < withEmb.length; j++) {
      if (!kept[j]) continue;
      if (cosineSimilarity(withEmb[i].embedding, withEmb[j].embedding) >= SIMILARITY_THRESHOLD) {
        kept[j] = false;
      }
    }
  }
  return withEmb.filter((_, i) => kept[i]).map((e) => e.fact);
}

/** Classify each fact into its memory network (world/experience/opinion). */
function applyNetworkClassification(facts: ExtractedFact[]): ExtractedFact[] {
  return facts.map((fact) => {
    const { network, opinionConfidence } = classifyNetwork(fact);
    return { ...fact, network, opinionConfidence } as ExtractedFact;
  });
}
