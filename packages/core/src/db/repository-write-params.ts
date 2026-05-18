/**
 * Positional-parameter assembly for the `memories` INSERT in
 * `repository-write.ts`. Each per-field default is resolved by a tiny
 * helper so `buildBaseParams` itself carries zero branches and the SQL
 * parameter order is obvious at a glance.
 */

import pgvector from 'pgvector/pg';

import { type StoreMemoryInput, clampImportance } from './repository-types.js';

interface RequiredStringDefaults {
  memoryType: string;
  sourceUrl: string;
  status: string;
  keywords: string;
  summary: string;
  overview: string;
  network: string;
}

function resolveRequiredStringDefaults(input: StoreMemoryInput): RequiredStringDefaults {
  return {
    memoryType: input.memoryType ?? 'semantic',
    sourceUrl: input.sourceUrl ?? '',
    status: input.status ?? 'active',
    keywords: input.keywords ?? '',
    summary: input.summary ?? '',
    overview: input.overview ?? '',
    network: input.network ?? 'experience',
  };
}

/** Optional columns that are stored as NULL when omitted. */
interface NullableMemoryDefaults {
  episodeId: string | null;
  namespace: string | null;
  opinionConfidence: number | null;
  observationSubject: string | null;
}

function resolveNullableMemoryDefaults(input: StoreMemoryInput): NullableMemoryDefaults {
  return {
    episodeId: input.episodeId ?? null,
    namespace: input.namespace ?? null,
    opinionConfidence: input.opinionConfidence ?? null,
    observationSubject: input.observationSubject ?? null,
  };
}

function resolveMetadataJson(input: StoreMemoryInput): string {
  return JSON.stringify(input.metadata ?? {});
}

function resolveTrustScore(input: StoreMemoryInput): number {
  return Math.max(0, Math.min(1, input.trustScore ?? 1.0));
}

function resolveObservedAtIso(input: StoreMemoryInput): string {
  return (input.observedAt ?? new Date()).toISOString();
}

/**
 * Build the 19 base positional parameters for memory insertion. The body is
 * a flat positional assembly — every per-field default is resolved by the
 * tiny `resolve*` helpers above so this function carries zero branches and
 * the SQL parameter order matches `BASE_COLUMNS` in `repository-write.ts`
 * line-for-line.
 */
export function buildBaseParams(input: StoreMemoryInput): { params: unknown[]; paramCount: number } {
  const strings = resolveRequiredStringDefaults(input);
  const nullable = resolveNullableMemoryDefaults(input);
  return {
    params: [
      input.userId,
      input.content,
      pgvector.toSql(input.embedding),
      strings.memoryType,
      clampImportance(input.importance),
      input.sourceSite,
      strings.sourceUrl,
      nullable.episodeId,
      strings.status,
      resolveMetadataJson(input),
      strings.keywords,
      nullable.namespace,
      strings.summary,
      strings.overview,
      resolveTrustScore(input),
      strings.network,
      nullable.opinionConfidence,
      nullable.observationSubject,
      resolveObservedAtIso(input),
    ],
    paramCount: 19,
  };
}
