/**
 * Disk-based extraction cache for deterministic eval runs.
 * Caches extractFacts() and resolveAUDN() results keyed by input hash.
 * When EXTRACTION_CACHE_ENABLED=true, identical inputs produce identical
 * outputs across runs, eliminating LLM non-determinism from eval comparisons.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import {
  extractFacts,
  resolveAUDN,
  type AUDNDecision,
  type ExtractionOptions,
  type ExtractedFact,
  type ExistingMemory,
} from './extraction.js';

function hashInput(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function cacheFilePath(key: string): string {
  return join(config.extractionCacheDir, `${key}.json`);
}

function readCache<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

function writeCache<T>(filePath: string, value: T): void {
  mkdirSync(config.extractionCacheDir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

export async function cachedExtractFacts(
  conversationText: string,
  options: ExtractionOptions = {},
): Promise<ExtractedFact[]> {
  if (!config.extractionCacheEnabled) return extractFacts(conversationText, options);

  const key = `extract-${hashInput([conversationText, JSON.stringify(options)])}`;
  const filePath = cacheFilePath(key);
  const cached = readCache<ExtractedFact[]>(filePath);
  if (cached) return cached;

  const result = await extractFacts(conversationText, options);
  writeCache(filePath, result);
  return result;
}

export async function cachedResolveAUDN(
  newFact: string,
  existingMemories: ExistingMemory[],
): Promise<AUDNDecision> {
  if (!config.extractionCacheEnabled) return resolveAUDN(newFact, existingMemories);

  const memoriesKey = JSON.stringify(existingMemories.map((m) => ({ id: m.id, content: m.content, similarity: m.similarity })));
  const key = `audn-${hashInput([newFact, memoriesKey])}`;
  const filePath = cacheFilePath(key);
  const cached = readCache<AUDNDecision>(filePath);
  if (cached) return cached;

  const result = await resolveAUDN(newFact, existingMemories);
  writeCache(filePath, result);
  return result;
}
