/**
 * Public API surface of the AtomicMemory memory engine.
 * Consumed by the standalone memory service and evaluation harness.
 */

export { MemoryService, type IngestResult, type RetrievalResult } from './services/memory-service.js';
export { MemoryRepository, type MemoryRow, type SearchResult, type EpisodeRow, type MemoryMetadata } from './db/memory-repository.js';
export { ClaimRepository } from './db/claim-repository.js';
export { pool } from './db/pool.js';
export {
  migrate,
  migrationStatus,
  MigrationLockTimeout,
  MigrationHistoryMismatch,
  type MigrateOptions,
  type MigrateResult,
  type EmbeddingDimensionStatus,
  type EmbeddingDimensionStatusValue,
  type MigrationHistoryStatus,
  type MigrationStatus,
  type MigrationStatusOptions,
} from './db/migration-api.js';
export {
  config,
  applyRuntimeConfigUpdates,
  updateRuntimeConfig,
  SUPPORTED_RUNTIME_CONFIG_FIELDS,
  INTERNAL_POLICY_CONFIG_FIELDS,
  type RuntimeConfig,
  type RuntimeConfigUpdates,
  type EmbeddingProviderName,
  type LLMProviderName,
  type VectorBackendName,
  type SupportedRuntimeConfigField,
  type InternalPolicyConfigField,
  type SupportedRuntimeConfig,
  type InternalPolicyConfig,
} from './config.js';
export { createMemoryRouter } from './routes/memories.js';
export { type RetrievalCitation } from './services/retrieval-format.js';
export {
  getRetrievalProfile,
  parseRetrievalProfile,
  type RetrievalProfile,
  type RetrievalProfileName,
} from './services/retrieval-profiles.js';
export {
  createCoreRuntime,
  type CoreRuntime,
  type CoreRuntimeDeps,
  type CoreRuntimeConfig,
  type CoreRuntimeRepos,
  type CoreRuntimeServices,
  type CoreRuntimeConfigRouteAdapter,
} from './app/runtime-container.js';
export { createApp } from './app/create-app.js';
export {
  checkEmbeddingDimensions,
  type EmbeddingDimensionCheckResult,
} from './app/startup-checks.js';
export { bindEphemeral, type BootedApp } from './app/bind-ephemeral.js';
export { initEmbedding, type EmbeddingConfig } from './services/embedding.js';
export { initLlm, type LLMConfig } from './services/llm.js';
