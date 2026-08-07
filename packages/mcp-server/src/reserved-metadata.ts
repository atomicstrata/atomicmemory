/**
 * @file Mirror of core `RESERVED_METADATA_KEYS` for MCP preflight and tool schema.
 * Keep in sync via `reserved-metadata.test.ts` drift guard against
 * `packages/core/src/db/repository-types.ts`.
 */

/** Keys core treats as internal — caller metadata must not include these. */
export const RESERVED_METADATA_KEYS = [
  'cmo_id',
  'memberMemoryIds',
  'compositeVersion',
  'headline',
  'entities',
  'relations',
  'keywords',
  'consolidated_from',
  'cluster_size',
  'avg_affinity',
  'recap',
  'topic',
  'member_count',
  'sourceSite',
  'findingCount',
  'rules',
  'trustScore',
  'threshold',
  'contradictionConfidence',
  'supersededMemoryId',
  'clarification_note',
  'target_memory_id',
  'contradiction_confidence',
  'raw_document_id',
  'document_chunk_id',
  'upload_result',
  'providerMetadata',
  'codec',
] as const;

const RESERVED_SET = new Set<string>(RESERVED_METADATA_KEYS);

/** Caller-controlled keys that are safe alongside reserved-key preflight. */
export const CALLER_ALLOWED_METADATA_KEYS = ['externalId', 'dedupe_key'] as const;

/**
 * Human- and agent-facing description for the `memory_ingest` metadata field.
 */
export function metadataSchemaDescription(): string {
  const reserved = RESERVED_METADATA_KEYS.join(', ');
  const allowed = CALLER_ALLOWED_METADATA_KEYS.join(', ');
  return (
    "Only valid with mode='verbatim' (Core rejects metadata on text/messages extraction). " +
    'Prefer provenance (source, sourceUrl, sourceId) for tagging and lineage. ' +
    `Allowed integration keys: ${allowed}. ` +
    `Do not use reserved core-internal keys (rejected before ingest): ${reserved}.`
  );
}

/**
 * Fail closed when caller metadata includes keys reserved by core.
 */
export function assertNoReservedMetadataKeys(
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata) return;
  const reserved = Object.keys(metadata).filter((key) => RESERVED_SET.has(key));
  if (reserved.length === 0) return;
  throw new Error(
    `metadata contains reserved key(s) [${reserved.join(', ')}] — ` +
      'these are core-internal and cannot be set by callers. ' +
      'Use provenance (source, sourceUrl, sourceId) for tags, or metadata.externalId / metadata.dedupe_key for integration.',
  );
}
