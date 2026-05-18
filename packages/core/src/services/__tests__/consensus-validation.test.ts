/**
 * Unit tests for A-MemGuard consensus validation.
 * Tests reasoning path parsing, judgment parsing, and the validation pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../llm.js', () => ({
  llm: {
    chat: vi.fn(),
  },
}));

vi.mock('../audit-events.js', () => ({
  emitAuditEvent: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    auditLoggingEnabled: false,
    consensusValidationEnabled: true,
    consensusMinMemories: 3,
  },
}));

import { llm } from '../llm.js';
import {
  validateConsensus,
  parseReasoningPath,
  parseJudgments,
  type ReasoningPath,
} from '../consensus-validation.js';

const mockChat = vi.mocked(llm.chat);

function makeMemories(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `mem-${i + 1}`,
    content: `Memory ${i + 1} content`,
  }));
}

describe('parseReasoningPath', () => {
  it('parses structured reasoning + entities', () => {
    const result = parseReasoningPath(
      'Reasoning: The user prefers TypeScript over JavaScript\nEntities: TypeScript, JavaScript, user',
    );
    expect(result.reasoning).toBe('The user prefers TypeScript over JavaScript');
    expect(result.entities).toEqual(['TypeScript', 'JavaScript', 'user']);
  });

  it('handles plain text without labels', () => {
    const result = parseReasoningPath('Simple reasoning about the query');
    expect(result.reasoning).toBe('Simple reasoning about the query');
    expect(result.entities).toEqual([]);
  });

  it('handles multi-line with entities on separate line', () => {
    const result = parseReasoningPath(
      'Reasoning: User works on React projects\nEntities: React, user\n',
    );
    expect(result.reasoning).toBe('User works on React projects');
    expect(result.entities).toEqual(['React', 'user']);
  });

  it('handles empty entities list', () => {
    const result = parseReasoningPath('Reasoning: Generic reasoning\nEntities: ');
    expect(result.reasoning).toBe('Generic reasoning');
    expect(result.entities).toEqual([]);
  });
});

describe('parseJudgments', () => {
  const paths: ReasoningPath[] = [
    { memoryId: 'mem-1', memoryContent: 'Content 1', reasoning: 'path 1', entities: [] },
    { memoryId: 'mem-2', memoryContent: 'Content 2', reasoning: 'path 2', entities: [] },
    { memoryId: 'mem-3', memoryContent: 'Content 3', reasoning: 'path 3', entities: [] },
  ];

  it('parses ALIGNED judgments', () => {
    const response = [
      'Path 1: ALIGNED confidence:0.95 reason:matches consensus',
      'Path 2: ALIGNED confidence:0.90 reason:consistent entities',
      'Path 3: ALIGNED confidence:0.88 reason:compatible chain',
    ].join('\n');

    const judgments = parseJudgments(response, paths);
    expectAllAligned(judgments, 3);
    expect(judgments[0].confidence).toBe(0.95);
  });

  it('parses DIVERGENT judgments', () => {
    const response = [
      'Path 1: ALIGNED confidence:0.90 reason:good',
      'Path 2: DIVERGENT confidence:0.85 reason:introduces unrelated entities',
      'Path 3: ALIGNED confidence:0.92 reason:matches',
    ].join('\n');

    const judgments = parseJudgments(response, paths);
    expect(judgments[1].aligned).toBe(false);
    expect(judgments[1].confidence).toBe(0.85);
    expect(judgments[1].divergenceReason).toBe('introduces unrelated entities');
  });

  it('defaults missing paths to aligned', () => {
    const response = 'Path 1: ALIGNED confidence:0.90 reason:ok';
    const judgments = parseJudgments(response, paths);
    expectAllAligned(judgments, 3);
  });

  it('handles case-insensitive parsing', () => {
    const response = 'Path 1: aligned Confidence:0.80 Reason:matches well';
    const judgments = parseJudgments(response, paths);
    expect(judgments[0].aligned).toBe(true);
    expect(judgments[0].confidence).toBe(0.80);
  });

  it('ignores invalid path numbers', () => {
    const response = 'Path 99: DIVERGENT confidence:0.50 reason:bad';
    const judgments = parseJudgments(response, paths);
    // All 3 paths should default to aligned since Path 99 is out of range
    expectAllAligned(judgments, 3);
  });
});

describe('validateConsensus', () => {
  beforeEach(() => {
    mockChat.mockReset();
  });

  it('skips validation when fewer than 3 memories', async () => {
    const result = await validateConsensus('query', makeMemories(2));
    expect(result.originalCount).toBe(2);
    expect(result.filteredCount).toBe(2);
    expect(result.removedMemoryIds).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('returns all memories when all paths align', async () => {
    const memories = makeMemories(3);

    // 3 reasoning path calls + 1 consensus + 1 judgment
    mockChat
      .mockResolvedValueOnce('Reasoning: Path 1\nEntities: A, B')
      .mockResolvedValueOnce('Reasoning: Path 2\nEntities: A, C')
      .mockResolvedValueOnce('Reasoning: Path 3\nEntities: A, B')
      .mockResolvedValueOnce('All paths agree on entity A.')
      .mockResolvedValueOnce([
        'Path 1: ALIGNED confidence:0.95 reason:ok',
        'Path 2: ALIGNED confidence:0.90 reason:ok',
        'Path 3: ALIGNED confidence:0.92 reason:ok',
      ].join('\n'));

    const result = await validateConsensus('what does user prefer?', memories);
    expect(result.originalCount).toBe(3);
    expect(result.filteredCount).toBe(3);
    expect(result.removedMemoryIds).toEqual([]);
  });

  it('filters divergent memories', async () => {
    const memories = makeMemories(4);

    // 4 reasoning paths + consensus + judgment
    mockChat
      .mockResolvedValueOnce('Reasoning: Normal path 1\nEntities: A')
      .mockResolvedValueOnce('Reasoning: Suspicious path\nEntities: X, Y, Z')
      .mockResolvedValueOnce('Reasoning: Normal path 3\nEntities: A, B')
      .mockResolvedValueOnce('Reasoning: Normal path 4\nEntities: A')
      .mockResolvedValueOnce('Consensus: paths 1, 3, 4 agree on entity A.')
      .mockResolvedValueOnce([
        'Path 1: ALIGNED confidence:0.95 reason:matches',
        'Path 2: DIVERGENT confidence:0.88 reason:introduces unrelated entities X, Y, Z',
        'Path 3: ALIGNED confidence:0.90 reason:matches',
        'Path 4: ALIGNED confidence:0.93 reason:matches',
      ].join('\n'));

    const result = await validateConsensus('query', memories);
    expect(result.originalCount).toBe(4);
    expect(result.filteredCount).toBe(3);
    expect(result.removedMemoryIds).toEqual(['mem-2']);
  });

  it('makes correct number of LLM calls', async () => {
    const memories = makeMemories(3);

    mockChat
      .mockResolvedValueOnce('Reasoning: P1\nEntities: A')
      .mockResolvedValueOnce('Reasoning: P2\nEntities: A')
      .mockResolvedValueOnce('Reasoning: P3\nEntities: A')
      .mockResolvedValueOnce('Consensus summary')
      .mockResolvedValueOnce('Path 1: ALIGNED confidence:0.9 reason:ok\nPath 2: ALIGNED confidence:0.9 reason:ok\nPath 3: ALIGNED confidence:0.9 reason:ok');

    await validateConsensus('q', memories);

    // 3 reasoning paths + 1 consensus + 1 judgment = 5 LLM calls
    expect(mockChat).toHaveBeenCalledTimes(5);
  });
});

/** Assert that all judgments are aligned and the array has the expected length. */
function expectAllAligned(judgments: Array<{ aligned: boolean }>, expectedLength: number) {
  expect(judgments).toHaveLength(expectedLength);
  expect(judgments.every((j) => j.aligned)).toBe(true);
}
