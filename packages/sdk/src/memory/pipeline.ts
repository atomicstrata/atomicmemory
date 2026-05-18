/**
 * @file V3 Memory Processing Pipeline
 *
 * SDK-level hooks for transforming data before/after provider calls.
 * Pipelines are SDK orchestration, not part of the provider standard.
 */

import type {
  IngestInput,
  IngestResult,
  SearchRequest,
  SearchResultPage,
  MemoryRef,
  Memory,
  ListRequest,
  ListResultPage,
} from './types';

export interface MemoryProcessingPipeline {
  preprocessIngest?(input: IngestInput): Promise<IngestInput[]>;
  postprocessIngest?(
    result: IngestResult,
    input: IngestInput
  ): Promise<void>;
  preprocessSearch?(request: SearchRequest): Promise<SearchRequest>;
  postprocessSearch?(
    page: SearchResultPage,
    request: SearchRequest
  ): Promise<SearchResultPage>;
  preprocessGet?(ref: MemoryRef): Promise<MemoryRef>;
  postprocessGet?(
    memory: Memory | null,
    ref: MemoryRef
  ): Promise<Memory | null>;
  postprocessList?(
    page: ListResultPage,
    request: ListRequest
  ): Promise<ListResultPage>;
}

/** No-op pipeline that passes data through unchanged. */
export const noopMemoryPipeline: MemoryProcessingPipeline =
  Object.freeze({});
