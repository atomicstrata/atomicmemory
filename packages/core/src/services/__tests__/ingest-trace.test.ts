/**
 * Unit tests for ingest trace collector.
 *
 * Verifies persisted JSON output, disabled no-op behavior, and basic shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IngestTraceCollector } from '../ingest-trace.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('IngestTraceCollector', () => {
  let writeFileSpy: import('vitest').Mock;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const fs = await import('node:fs');
    writeFileSpy = fs.writeFileSync as unknown as import('vitest').Mock;
    writeFileSpy.mockReset();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  function getWrittenTrace(): Record<string, unknown> {
    const jsonStr = writeFileSpy.mock.calls[0][1] as string;
    return JSON.parse(jsonStr);
  }

  it('persists a structured ingest trace when enabled', () => {
    const collector = new IngestTraceCollector(true);
    collector.record({
      factText: 'Alice changed jobs.',
      headline: 'Alice changed jobs',
      factType: 'person',
      importance: 0.8,
      decision: {
        source: 'llm-audn',
        action: 'SUPERSEDE',
        reasonCode: 'llm-audn-supersede',
        targetMemoryId: 'mem-1',
      },
      outcome: 'deleted',
      memoryId: 'mem-2',
    });

    const traceId = collector.finalize({
      mode: 'full',
      userId: 'user-1',
      sourceSite: 'test',
      sourceUrl: 'https://example.com',
      episodeId: 'ep-1',
      factsExtracted: 1,
    });

    expect(traceId).toMatch(/^ingest-trace-/);
    expect(writeFileSpy).toHaveBeenCalledOnce();
    const output = getWrittenTrace();
    expect(output.traceId).toBe(traceId);
    expect(output.mode).toBe('full');
    expect(output.userId).toBe('user-1');
    expect(output.factsExtracted).toBe(1);
    expect(output.facts).toHaveLength(1);
  });

  it('is a complete no-op when disabled', () => {
    const collector = new IngestTraceCollector(false);
    collector.record({
      factText: 'ignored',
      headline: 'ignored',
      factType: 'knowledge',
      importance: 0.1,
      decision: {
        source: 'direct-store',
        action: 'ADD',
        reasonCode: 'direct-store-no-candidates',
        targetMemoryId: null,
      },
      outcome: 'stored',
      memoryId: 'mem-1',
    });

    const traceId = collector.finalize({
      mode: 'quick',
      userId: 'user-1',
      sourceSite: 'test',
      sourceUrl: '',
      episodeId: 'ep-1',
      factsExtracted: 1,
    });

    expect(traceId).toBeUndefined();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
