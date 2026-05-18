/**
 * @file Shared adapter helpers. Both `atomicmemory.ts` and `mem0.ts`
 * call the same SDK MemoryClient methods and translate to/from the
 * same CLI shapes; the only meaningful provider-specific behavior
 * lives in capability gates (mem0 rejects verbatim ingest + package).
 *
 * Extracted to one module so the two adapter files stop drifting and
 * so the per-mode ingest mapping can be split into small functions
 * (each ingest mode lives in its own helper, keeping the dispatcher's
 * cyclomatic / cognitive complexity low).
 */

import {
  MemoryClient,
  type IngestInput as SdkIngestInput,
  type FilterExpr as SdkFilterExpr,
  type ListRequest as SdkListRequest,
  type ListResultPage as SdkListResultPage,
  type MemoryClientConfig,
  type SearchRequest as SdkSearchRequest,
  type SearchResultPage as SdkSearchResultPage,
} from '@atomicmemory/sdk';
import type { CliProfileShape } from '../config/schema.js';
import { CliError } from '../types.js';
import {
  cliProvenanceToSdk,
  cliScopeToSdkScope,
  sdkMemoryToCli,
} from './scope-mapper.js';
import type {
  AdapterIngestInput,
  AdapterListInput,
  AdapterListResult,
  AdapterSearchHit,
  AdapterSearchInput,
  AdapterStatus,
} from './types.js';

type SdkProviderName = 'atomicmemory' | 'mem0';

export function buildClientConfig(
  profile: CliProfileShape,
  provider: SdkProviderName,
): MemoryClientConfig {
  const providerConfig: { apiUrl: string; apiKey?: string } = {
    apiUrl: profile.apiUrl,
  };
  if (profile.apiKey) providerConfig.apiKey = profile.apiKey;
  return {
    providers: { [provider]: providerConfig },
    defaultProvider: provider,
  };
}

export function statusFromClient(
  client: MemoryClient,
  provider: SdkProviderName,
): AdapterStatus {
  const all = client.getProviderStatus();
  const ours = all.find((s) => s.name === provider);
  const status: AdapterStatus = {
    ok: ours?.initialized === true,
    provider,
  };
  if (!status.ok) {
    status.detail = ours
      ? `provider "${ours.name}" not initialized`
      : `no status reported by SDK for provider "${provider}"`;
  }
  return status;
}

interface IngestTail {
  scope: ReturnType<typeof cliScopeToSdkScope>;
  provenance?: ReturnType<typeof cliProvenanceToSdk>;
  metadata?: Record<string, unknown>;
}

function ingestTail(input: AdapterIngestInput): IngestTail {
  const tail: IngestTail = { scope: cliScopeToSdkScope(input.scope) };
  if (input.provenance) tail.provenance = cliProvenanceToSdk(input.provenance);
  if (input.metadata !== undefined) tail.metadata = input.metadata;
  return tail;
}

function ingestText(input: AdapterIngestInput, tail: IngestTail): SdkIngestInput {
  if (!input.text) {
    throw new CliError('missing_input', 'ingest mode "text" requires text content');
  }
  return { mode: 'text', content: input.text, ...tail };
}

function ingestMessages(input: AdapterIngestInput, tail: IngestTail): SdkIngestInput {
  if (!input.messages || input.messages.length === 0) {
    throw new CliError(
      'missing_input',
      'ingest mode "messages" requires at least one message',
    );
  }
  return { mode: 'messages', messages: input.messages, ...tail };
}

function ingestVerbatim(input: AdapterIngestInput, tail: IngestTail): SdkIngestInput {
  if (!input.text) {
    throw new CliError('missing_input', 'ingest mode "verbatim" requires text content');
  }
  return {
    mode: 'verbatim',
    content: input.text,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...tail,
  };
}

export function toSdkIngestInput(input: AdapterIngestInput): SdkIngestInput {
  const tail = ingestTail(input);
  switch (input.mode) {
    case 'text':
      return ingestText(input, tail);
    case 'messages':
      return ingestMessages(input, tail);
    case 'verbatim':
      return ingestVerbatim(input, tail);
  }
}

export function toSdkSearchRequest(input: AdapterSearchInput): SdkSearchRequest {
  const req: SdkSearchRequest = {
    query: input.query,
    scope: cliScopeToSdkScope(input.scope),
  };
  if (input.limit !== undefined) req.limit = input.limit;
  if (input.filterJson !== undefined) req.filter = input.filterJson as SdkFilterExpr;
  if (input.reranker !== undefined) req.reranker = input.reranker;
  return req;
}

export function mapSearchHits(page: SdkSearchResultPage): AdapterSearchHit[] {
  return page.results.map((hit) => ({
    memory: sdkMemoryToCli(hit.memory),
    score: hit.score,
    ...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
    ...(hit.rankingScore !== undefined ? { rankingScore: hit.rankingScore } : {}),
    ...(hit.relevance !== undefined ? { relevance: hit.relevance } : {}),
  }));
}

export function toSdkListRequest(input: AdapterListInput): SdkListRequest {
  const req: SdkListRequest = { scope: cliScopeToSdkScope(input.scope) };
  if (input.limit !== undefined) req.limit = input.limit;
  if (input.cursor !== undefined) req.cursor = input.cursor;
  return req;
}

export function mapListResult(page: SdkListResultPage): AdapterListResult {
  return {
    memories: page.memories.map(sdkMemoryToCli),
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
  };
}
