/**
 * Unit tests for retrieval trace collector.
 * Verifies trace capture, no-op behavior when disabled, and output format.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TraceCollector } from '../retrieval-trace.js';
import { config } from '../../config.js';
import { createSearchResult } from './test-fixtures.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

function makeResult(id: string, similarity: number, score: number, content: string) {
  return createSearchResult({ id, content, similarity, score });
}

describe('TraceCollector', () => {
  let writeFileSpy: import('vitest').Mock;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const fs = await import('node:fs');
    writeFileSpy = fs.writeFileSync as unknown as import('vitest').Mock;
    writeFileSpy.mockReset();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /** Parse the JSON written to disk via writeFileSync. */
  function getWrittenTrace(): Record<string, unknown> {
    const jsonStr = writeFileSpy.mock.calls[0][1] as string;
    return JSON.parse(jsonStr);
  }

  it('emits JSON trace to stdout when enabled', () => {
    config.retrievalTraceEnabled = true;
    const trace = new TraceCollector('test query', 'user-1');
    const results = [makeResult('m1', 0.95, 0.88, 'Alice likes cats')];

    trace.stage('initial', results, { candidateDepth: 15 });
    trace.setRetrievalSummary({
      candidateIds: ['m1'],
      candidateCount: 1,
      queryText: 'test query',
      skipRepair: false,
    });
    trace.finalize(results);

    expect(writeFileSpy).toHaveBeenCalledOnce();
    expect(trace.getRetrievalSummary()).toMatchObject({
      traceId: expect.stringMatching(/^trace-/),
      stageCount: 2,
      stageNames: ['initial', 'final'],
    });
    const output = getWrittenTrace();
    expect(output.query).toBe('test query');
    expect(output.userId).toBe('user-1');
    expect(output.stages).toHaveLength(2);
    expect((output.stages as Array<{ name: string }>)[0].name).toBe('initial');
    expect((output.stages as Array<{ name: string }>)[1].name).toBe('final');
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('is a complete no-op when disabled', () => {
    config.retrievalTraceEnabled = false;
    const trace = new TraceCollector('test query', 'user-1');
    const results = [makeResult('m1', 0.95, 0.88, 'Alice likes cats')];

    trace.stage('initial', results);
    trace.stage('mmr', results);
    trace.finalize(results);

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('records multiple stages in order', () => {
    config.retrievalTraceEnabled = true;
    const trace = new TraceCollector('multi-stage', 'user-2');
    const initial = [makeResult('m1', 0.9, 0.8, 'fact one'), makeResult('m2', 0.7, 0.6, 'fact two')];
    const mmr = [makeResult('m1', 0.9, 0.8, 'fact one')];

    trace.stage('initial', initial, { candidateDepth: 20 });
    trace.stage('mmr', mmr, { lambda: 0.7 });
    trace.finalize(mmr);

    const output = getWrittenTrace();
    const stages = output.stages as Array<{ name: string; count: number }>;
    expect(stages.map((s) => s.name)).toEqual([
      'initial', 'mmr', 'final',
    ]);
    expect(stages[0].count).toBe(2);
    expect(stages[1].count).toBe(1);
  });

  it('truncates content preview to 120 characters', () => {
    config.retrievalTraceEnabled = true;
    const longContent = 'A'.repeat(200);
    const trace = new TraceCollector('preview test', 'user-3');
    const results = [makeResult('m1', 0.9, 0.8, longContent)];

    trace.finalize(results);

    const output = getWrittenTrace();
    const stages = output.stages as Array<{ memories: Array<{ contentPreview: string }> }>;
    const preview = stages[0].memories[0].contentPreview;
    expect(preview.length).toBe(120);
  });

  it('rounds scores to 4 decimal places', () => {
    config.retrievalTraceEnabled = true;
    const trace = new TraceCollector('rounding test', 'user-4');
    const results = [makeResult('m1', 0.123456789, 0.987654321, 'precise')];

    trace.finalize(results);

    const output = getWrittenTrace();
    const stages = output.stages as Array<{ memories: Array<{ similarity: number; score: number }> }>;
    const mem = stages[0].memories[0];
    expect(mem.similarity).toBe(0.1235);
    expect(mem.score).toBe(0.9877);
  });

  it('captures safe score semantics and source fields', () => {
    config.retrievalTraceEnabled = true;
    const trace = new TraceCollector('score semantics', 'user-4');
    const results = [
      createSearchResult({
        id: 'integration-1',
        content: 'Sensitive body is preview-limited.',
        similarity: 0.23456,
        semantic_similarity: 0.23456,
        score: 0.98765,
        ranking_score: 0.98765,
        relevance: 0.23456,
        importance: 0.8,
        source_site: 'integration-google',
        namespace: 'site/integration-google',
      }),
    ];

    trace.stage('relevance-filter', results, {
      decisions: [{
        id: 'integration-1',
        sourceSite: 'integration-google',
        sourceKind: 'integration',
        namespace: 'site/integration-google',
        semanticSimilarity: 0.23456,
        rankingScore: 0.98765,
        relevance: 0.23456,
        threshold: 0.5,
        decision: 'filtered',
        reason: 'integration-below-threshold',
      }],
    });
    trace.finalize([]);

    const output = getWrittenTrace();
    const stages = output.stages as Array<{ memories: Array<Record<string, unknown>>; meta?: Record<string, unknown> }>;
    expect(stages[0].memories[0]).toMatchObject({
      id: 'integration-1',
      semanticSimilarity: 0.2346,
      rankingScore: 0.9877,
      relevance: 0.2346,
      importance: 0.8,
      sourceSite: 'integration-google',
      namespace: 'site/integration-google',
    });
    expect(stages[0].meta?.decisions).toEqual([
      expect.objectContaining({ id: 'integration-1', reason: 'integration-below-threshold' }),
    ]);
  });

  it('includes metadata in stage output', () => {
    config.retrievalTraceEnabled = true;
    const trace = new TraceCollector('meta test', 'user-5');

    trace.stage('repair-accepted', [], {
      rewrittenQuery: 'rephrased query',
      simDelta: 0.15,
    });
    trace.finalize([]);

    const output = getWrittenTrace();
    const stages = output.stages as Array<{ meta?: Record<string, unknown> }>;
    expect(stages[0].meta).toEqual({
      rewrittenQuery: 'rephrased query',
      simDelta: 0.15,
    });
  });

  it('includes ISO timestamp', () => {
    config.retrievalTraceEnabled = true;
    const trace = new TraceCollector('time test', 'user-6');

    trace.finalize([]);

    const output = getWrittenTrace();
    expect(() => new Date(output.timestamp as string)).not.toThrow();
    expect(output.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
