/**
 * @file V3 Memory Provider Registration
 *
 * Types for pairing a provider with an optional processing pipeline
 * at registration time.
 */

import type { MemoryProvider } from './provider';
import type { MemoryProcessingPipeline } from './pipeline';

/** A provider paired with its optional pipeline. */
export interface MemoryProviderRegistration {
  provider: MemoryProvider;
  pipeline?: MemoryProcessingPipeline;
}

/** Registry entry template for provider factory functions. */
export interface MemoryProviderEntry<Config> {
  name: string;
  create(config: Config): MemoryProviderRegistration;
}
