/**
 * Unit tests for extraction-cache.ts.
 * Tests caching behavior, cache hits/misses, deterministic hashing,
 * and atomic file writes using a temp directory and mocked extraction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const TEST_CACHE_DIR = join(tmpdir(), `extraction-cache-test-${randomBytes(4).toString('hex')}`);

/** Mock config before importing cache module. */
vi.mock('../../config.js', () => ({
  config: {
    extractionCacheEnabled: true,
    extractionCacheDir: TEST_CACHE_DIR,
  },
}));

const mockExtractFacts = vi.fn();
const mockResolveAUDN = vi.fn();

vi.mock('../extraction.js', () => ({
  extractFacts: (...args: unknown[]) => mockExtractFacts(...args),
  resolveAUDN: (...args: unknown[]) => mockResolveAUDN(...args),
}));

const { cachedExtractFacts, cachedResolveAUDN } = await import('../extraction-cache.js');

beforeEach(() => {
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
  mockExtractFacts.mockReset();
  mockResolveAUDN.mockReset();
});

afterEach(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
});

describe('cachedExtractFacts', () => {
  const SAMPLE_FACTS = [
    { fact: 'User prefers Vite', headline: 'Prefers Vite', importance: 0.7, type: 'preference', keywords: ['Vite'] },
  ];

  it('calls extractFacts on cache miss', async () => {
    mockExtractFacts.mockResolvedValueOnce(SAMPLE_FACTS);

    const result = await cachedExtractFacts('some conversation');

    expect(mockExtractFacts).toHaveBeenCalledOnce();
    expect(mockExtractFacts).toHaveBeenCalledWith('some conversation', {});
    expect(result).toEqual(SAMPLE_FACTS);
  });

  it('writes cache file on miss', async () => {
    mockExtractFacts.mockResolvedValueOnce(SAMPLE_FACTS);

    await cachedExtractFacts('test conversation');

    const files = readdirSync(TEST_CACHE_DIR).filter((f) => f.startsWith('extract-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^extract-[a-f0-9]{16}\.json$/);
  });

  it('returns cached result on hit without calling extractFacts', async () => {
    mockExtractFacts.mockResolvedValueOnce(SAMPLE_FACTS);

    const first = await cachedExtractFacts('cached conversation');
    const second = await cachedExtractFacts('cached conversation');

    expect(mockExtractFacts).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it('produces different cache keys for different inputs', async () => {
    mockExtractFacts.mockResolvedValue(SAMPLE_FACTS);

    await cachedExtractFacts('conversation A');
    await cachedExtractFacts('conversation B');

    expect(mockExtractFacts).toHaveBeenCalledTimes(2);
    const files = readdirSync(TEST_CACHE_DIR).filter((f) => f.startsWith('extract-'));
    expect(files).toHaveLength(2);
  });

  it('cache file contains valid JSON matching the result', async () => {
    mockExtractFacts.mockResolvedValueOnce(SAMPLE_FACTS);

    await cachedExtractFacts('json check');

    const files = readdirSync(TEST_CACHE_DIR).filter((f) => f.startsWith('extract-'));
    const content = JSON.parse(readFileSync(join(TEST_CACHE_DIR, files[0]), 'utf-8'));
    expect(content).toEqual(SAMPLE_FACTS);
  });

  it('does not leave .tmp files after write', async () => {
    mockExtractFacts.mockResolvedValueOnce(SAMPLE_FACTS);

    await cachedExtractFacts('tmp check');

    const files = readdirSync(TEST_CACHE_DIR);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('cachedResolveAUDN', () => {
  const SAMPLE_DECISION = {
    action: 'ADD' as const,
    targetMemoryId: null,
    updatedContent: null,
    clarificationNote: null,
    contradictionConfidence: null,
  };

  const EXISTING_MEMORIES = [
    { id: 'mem-1', content: 'User likes TypeScript', similarity: 0.85 },
  ];

  it('calls resolveAUDN on cache miss', async () => {
    mockResolveAUDN.mockResolvedValueOnce(SAMPLE_DECISION);

    const result = await cachedResolveAUDN('new fact', EXISTING_MEMORIES);

    expect(mockResolveAUDN).toHaveBeenCalledOnce();
    expect(mockResolveAUDN).toHaveBeenCalledWith('new fact', EXISTING_MEMORIES);
    expect(result).toEqual(SAMPLE_DECISION);
  });

  it('returns cached result on hit', async () => {
    mockResolveAUDN.mockResolvedValueOnce(SAMPLE_DECISION);

    const first = await cachedResolveAUDN('fact A', EXISTING_MEMORIES);
    const second = await cachedResolveAUDN('fact A', EXISTING_MEMORIES);

    expect(mockResolveAUDN).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it('cache key includes existing memories', async () => {
    mockResolveAUDN.mockResolvedValue(SAMPLE_DECISION);
    const differentMemories = [
      { id: 'mem-2', content: 'User likes Python', similarity: 0.75 },
    ];

    await cachedResolveAUDN('same fact', EXISTING_MEMORIES);
    await cachedResolveAUDN('same fact', differentMemories);

    expect(mockResolveAUDN).toHaveBeenCalledTimes(2);
  });

  it('writes audn-prefixed cache files', async () => {
    mockResolveAUDN.mockResolvedValueOnce(SAMPLE_DECISION);

    await cachedResolveAUDN('audn test', EXISTING_MEMORIES);

    const files = readdirSync(TEST_CACHE_DIR).filter((f) => f.startsWith('audn-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^audn-[a-f0-9]{16}\.json$/);
  });
});

describe('cache disabled', () => {
  it('bypasses cache when extractionCacheEnabled is false', async () => {
    const { config } = await import('../../config.js');
    const originalEnabled = config.extractionCacheEnabled;
    (config as { extractionCacheEnabled: boolean }).extractionCacheEnabled = false;

    const facts = [{ fact: 'test', headline: 'test', importance: 0.5, type: 'preference', keywords: [] }];
    mockExtractFacts.mockResolvedValue(facts);

    const first = await cachedExtractFacts('bypass test');
    const second = await cachedExtractFacts('bypass test');

    expect(mockExtractFacts).toHaveBeenCalledTimes(2);
    expect(first).toEqual(facts);

    (config as { extractionCacheEnabled: boolean }).extractionCacheEnabled = originalEnabled;
  });
});
