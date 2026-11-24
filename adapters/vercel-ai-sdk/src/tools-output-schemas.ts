/** Validate and allowlist model-facing SDK output; SDK mappers do not validate raw JSON. */
import { z } from 'zod/v3';
import type { RetrievalReceipt } from '@atomicmemory/sdk';

const id = z.string().min(1);
export const hitSchema = z.object({
  memory: z.object({ id, content: z.string() }),
  score: z.number().finite(),
  similarity: z.number().finite().optional(),
  rankingScore: z.number().finite().optional(),
  relevance: z.number().finite().optional(),
  versionId: id.nullable().optional(),
  observedAt: z.string().optional(),
});

const receiptSchema = z.object({
  embeddingProvider: z.string().optional(),
  embeddingModel: z.string(),
  embeddingModelVersion: z.string(),
  embeddingDimensions: z.number().int().positive(),
  queryText: z.string(),
  candidateIds: z.array(id),
  traceId: id,
}).transform(({ embeddingProvider, ...receipt }): RetrievalReceipt => ({
  ...receipt,
  ...(embeddingProvider !== undefined ? { embeddingProvider } : {}),
}));

export const searchOutputSchema = z.object({
  results: z.array(hitSchema),
  retrieval: receiptSchema.optional(),
  cursor: z.string().optional(),
});

export const ingestOutputSchema = z.object({
  created: z.array(id), updated: z.array(id), unchanged: z.array(id),
});
