/**
 * Unit tests for the temporal-state write-time classifier.
 * Mocks `callAnthropicTool` so no real LLM call is issued.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock must be hoisted before the import that uses it.
vi.mock('../llm.js', () => ({
  callAnthropicTool: vi.fn(),
}));

import { callAnthropicTool } from '../llm.js';
import {
  classifyTemporalState,
  scopedKey,
} from '../temporal-classifier.js';

const mockCallTool = vi.mocked(callAnthropicTool);

const USER = 'user-1';
const MODEL = 'claude-haiku-4-5';
const OBSERVED = new Date('2026-03-01T12:00:00Z');

interface ToolOutput {
  kind: 'stateful' | 'non_stateful';
  state_key: string;
  event_start_iso: string;
  rationale: string;
}

function mockToolReturn(value: ToolOutput): void {
  mockCallTool.mockResolvedValueOnce(value as never);
}

const STATEFUL_FIXTURES: Array<{ text: string; key: string }> = [
  { text: 'User lives in Austin, TX', key: 'location' },
  { text: 'Alice job title is Staff Engineer', key: 'job.title' },
  { text: 'Dashboard API response time is 200ms', key: 'api.dashboard.response_time' },
  { text: 'User current diet is vegetarian', key: 'diet' },
  { text: 'Project lead is Bob', key: 'project.lead' },
  { text: 'User employer is Acme Inc', key: 'job.employer' },
];

const NON_STATEFUL_FIXTURES: string[] = [
  'User flew to Tokyo last week',
  'Asked about pricing on March 3rd',
  'Discussed AUDN architecture in the standup',
  'Mentioned that Q3 was tough',
  'User reported a bug in checkout flow',
  'Sent the design doc to the team',
];

describe('classifyTemporalState — stateful fixtures', () => {
  beforeEach(() => { mockCallTool.mockReset(); });

  it.each(STATEFUL_FIXTURES)(
    'classifies stateful fact "%s"',
    async (fixture) => {
      mockToolReturn({
        kind: 'stateful',
        state_key: fixture.key,
        event_start_iso: '',
        rationale: 'evolving attribute',
      });
      const result = await classifyTemporalState({
        memoryText: fixture.text, observedAt: OBSERVED, userId: USER, model: MODEL,
      });
      expect(result).not.toBeNull();
      expect(result!.stateKey).toBe(scopedKey(USER, fixture.key));
      expect(result!.eventEnd).toBeNull();
      // Falls back to observedAt when LLM doesn't provide event_start_iso.
      expect(result!.eventStart.toISOString()).toBe(OBSERVED.toISOString());
    },
  );
});

describe('classifyTemporalState — non-stateful fixtures', () => {
  beforeEach(() => { mockCallTool.mockReset(); });

  it.each(NON_STATEFUL_FIXTURES)(
    'returns null for one-time event "%s"',
    async (text) => {
      mockToolReturn({
        kind: 'non_stateful', state_key: '', event_start_iso: '', rationale: 'one-time event',
      });
      const result = await classifyTemporalState({
        memoryText: text, observedAt: OBSERVED, userId: USER, model: MODEL,
      });
      expect(result).toBeNull();
    },
  );
});

describe('classifyTemporalState — output validation', () => {
  beforeEach(() => { mockCallTool.mockReset(); });

  it('uses event_start_iso when present and parseable', async () => {
    mockToolReturn({
      kind: 'stateful', state_key: 'location',
      event_start_iso: '2026-04-15T09:00:00Z', rationale: '',
    });
    const result = await classifyTemporalState({
      memoryText: 'User lives in Tokyo', observedAt: OBSERVED, userId: USER, model: MODEL,
    });
    expect(result!.eventStart.toISOString()).toBe('2026-04-15T09:00:00.000Z');
  });

  it('rejects invalid slug-cased state_key', async () => {
    mockToolReturn({
      kind: 'stateful', state_key: 'Some Key With Spaces',
      event_start_iso: '', rationale: '',
    });
    const result = await classifyTemporalState({
      memoryText: 'x', observedAt: OBSERVED, userId: USER, model: MODEL,
    });
    expect(result).toBeNull();
  });

  it('namespaces state_key under user scope', () => {
    expect(scopedKey('u-42', 'location')).toBe('user:u-42:location');
  });

  it('propagates classifier transport errors (fail-closed)', async () => {
    mockCallTool.mockRejectedValueOnce(new Error('rate limit'));
    await expect(classifyTemporalState({
      memoryText: 'x', observedAt: OBSERVED, userId: USER, model: MODEL,
    })).rejects.toThrow(/rate limit/);
  });
});
