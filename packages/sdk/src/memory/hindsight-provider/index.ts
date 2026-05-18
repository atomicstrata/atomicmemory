/**
 * @file Hindsight Provider Exports
 *
 * Browser-safe exports for the Hindsight memory provider. This entry point
 * intentionally re-exports only provider code, types, and extension handles
 * that depend on the shared fetch-based HTTP helper rather than Node-only APIs.
 */

export { HindsightProvider } from './hindsight-provider';
export type {
  HindsightProviderConfig,
  HindsightRecallBudget,
  HindsightTagsMatch,
  HindsightRetainItem,
  HindsightRetainRequest,
  HindsightRetainResponse,
  HindsightOperation,
  HindsightOperationsPage,
  HindsightRetainHandle,
  HindsightOperationsHandle,
} from './types';
export {
  HINDSIGHT_DEFAULT_TIMEOUT,
  HINDSIGHT_DEFAULT_API_VERSION,
  HINDSIGHT_DEFAULT_PROJECT_ID,
  HINDSIGHT_DEFAULT_MAX_TOKENS,
  HINDSIGHT_SCOPE_TAGS_MATCH,
} from './types';
