/**
 * Unit tests for IE/KU (Information Extraction / Knowledge Update) specialist.
 *
 * All LLM calls are mocked — no Postgres or API keys required.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  shouldInvokeIeKuSpecialist,
  runIeKuSpecialist,
  type IeKuSpecialistDeps,
} from '../ie-ku-specialist.js';

vi.mock('../../llm.js', () => ({
  callAnthropicTool: vi.fn(),
}));

import { callAnthropicTool } from '../../llm.js';

const fakeValues = (row: unknown): Pick<IeKuSpecialistDeps['values'], 'findLatest'> => ({
  findLatest: vi.fn().mockResolvedValue(row),
});

describe('shouldInvokeIeKuSpecialist', () => {
  it('matches "what is the X"', () => {
    expect(shouldInvokeIeKuSpecialist('What is the daily call quota?')).toBe(true);
  });
  it('matches "when does X"', () => {
    expect(shouldInvokeIeKuSpecialist('When does my first sprint end?')).toBe(true);
  });
  it('does NOT match list/contradiction questions', () => {
    expect(shouldInvokeIeKuSpecialist('How many features did I add?')).toBe(false);
    expect(shouldInvokeIeKuSpecialist('Have I ever used Flask?')).toBe(false);
  });
});

describe('runIeKuSpecialist', () => {
  it('returns handled=false when query does not match', async () => {
    const result = await runIeKuSpecialist({
      values: fakeValues(null) as IeKuSpecialistDeps['values'],
      query: 'How many features?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
    });
    expect(result.handled).toBe(false);
  });

  it('returns handled=false when entity_values miss', async () => {
    (callAnthropicTool as ReturnType<typeof vi.fn>).mockResolvedValue({ entity: 'X', attribute: 'Y' });
    const result = await runIeKuSpecialist({
      values: fakeValues(null) as IeKuSpecialistDeps['values'],
      query: 'What is the X?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
    });
    expect(result.handled).toBe(false);
    expect(result.matchedEntity).toBe('X');
  });

  it('returns the literal value on hit', async () => {
    (callAnthropicTool as ReturnType<typeof vi.fn>).mockResolvedValue({ entity: 'API key', attribute: 'daily quota' });
    const result = await runIeKuSpecialist({
      values: fakeValues({
        id: 'r1', userId: 'u1', entity: 'API key', attribute: 'daily quota',
        value: '1,200 calls per day', valueType: 'number',
        observedAt: new Date(), factId: 'm1', createdAt: new Date(),
      }) as IeKuSpecialistDeps['values'],
      query: 'What is the daily call quota for the API key?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
    });
    expect(result.handled).toBe(true);
    expect(result.answer).toBe('1,200 calls per day');
  });
});
