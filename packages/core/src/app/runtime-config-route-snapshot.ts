/**
 * Shared runtime-config route snapshot shape and formatter.
 *
 * Both the composed runtime container and the legacy route module need the
 * same public config subset. Keeping the projection here prevents drift in
 * `/v1/memories/health` and `/v1/memories/config` responses.
 */

import type { EmbeddingProviderName, LLMProviderName, RuntimeConfig } from '../config.js';

export interface RuntimeConfigRouteSnapshot {
  retrievalProfile: string;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  voyageDocumentModel: string;
  voyageQueryModel: string;
  llmProvider: LLMProviderName;
  llmModel: string;
  clarificationConflictThreshold: number;
  maxSearchResults: number;
  hybridSearchEnabled: boolean;
  iterativeRetrievalEnabled: boolean;
  entityGraphEnabled: boolean;
  crossEncoderEnabled: boolean;
  agenticRetrievalEnabled: boolean;
  repairLoopEnabled: boolean;
  runtimeConfigMutationEnabled: boolean;
}

export function readRuntimeConfigRouteSnapshot(config: RuntimeConfig): RuntimeConfigRouteSnapshot {
  return {
    retrievalProfile: config.retrievalProfile,
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    voyageDocumentModel: config.voyageDocumentModel,
    voyageQueryModel: config.voyageQueryModel,
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    clarificationConflictThreshold: config.clarificationConflictThreshold,
    maxSearchResults: config.maxSearchResults,
    hybridSearchEnabled: config.hybridSearchEnabled,
    iterativeRetrievalEnabled: config.iterativeRetrievalEnabled,
    entityGraphEnabled: config.entityGraphEnabled,
    crossEncoderEnabled: config.crossEncoderEnabled,
    agenticRetrievalEnabled: config.agenticRetrievalEnabled,
    repairLoopEnabled: config.repairLoopEnabled,
    runtimeConfigMutationEnabled: config.runtimeConfigMutationEnabled,
  };
}
