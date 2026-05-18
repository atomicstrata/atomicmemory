/**
 * Structured ingest trace collector.
 *
 * Mirrors the retrieval trace seam for write-path diagnostics: one trace per
 * ingest request, persisted as JSON when config.ingestTraceEnabled is true.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { IngestFactTrace } from './memory-service-types.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const DEFAULT_TRACE_DIR = resolve(__dirname, '../../.traces/ingest');

export interface IngestTraceSummary {
  mode: 'full' | 'quick' | 'workspace' | 'verbatim';
  userId: string;
  sourceSite: string;
  sourceUrl: string;
  episodeId: string;
  factsExtracted: number;
}

export interface IngestTraceArtifact extends IngestTraceSummary {
  traceId: string;
  timestamp: string;
  durationMs: number;
  facts: IngestFactTrace[];
}

export class IngestTraceCollector {
  private readonly enabled: boolean;
  private readonly startTime: number;
  private readonly traceId: string;
  private readonly facts: IngestFactTrace[] = [];

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.startTime = Date.now();
    this.traceId = `ingest-trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  record(trace: IngestFactTrace): void {
    if (!this.enabled) return;
    this.facts.push(trace);
  }

  finalize(summary: IngestTraceSummary): string | undefined {
    if (!this.enabled) return undefined;
    const artifact: IngestTraceArtifact = {
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - this.startTime,
      ...summary,
      facts: this.facts,
    };
    this.persist(artifact);
    return this.traceId;
  }

  private persist(trace: IngestTraceArtifact): void {
    try {
      const traceDir = config.ingestTraceDir || DEFAULT_TRACE_DIR;
      if (!existsSync(traceDir)) {
        mkdirSync(traceDir, { recursive: true });
      }
      const filename = `${trace.traceId}.json`;
      const filePath = join(traceDir, filename);
      writeFileSync(filePath, JSON.stringify(trace, null, 2));
      console.log(`[ingest-trace] Saved ingest trace: ${filename} (${trace.durationMs}ms, ${trace.facts.length} facts)`);
    } catch (err) {
      console.error('[ingest-trace] Failed to persist ingest trace:', err);
    }
  }
}

const CONTENT_PREVIEW_LENGTH = 120;

export function previewContent(content: string): string {
  return content.slice(0, CONTENT_PREVIEW_LENGTH);
}
