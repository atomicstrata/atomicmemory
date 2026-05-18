/**
 * Unit tests for extraction.ts pure functions.
 * Tests action normalization, confidence inference, headline generation,
 * and default decision construction — all without LLM calls.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

/** Mock llm and fact-normalization to avoid config.ts env var requirements. */
vi.mock('../llm.js', () => ({ llm: { chat: vi.fn() } }));
vi.mock('../fact-normalization.js', () => ({
  normalizeExtractedFacts: (facts: unknown[]) => facts,
}));

const { llm } = await import('../llm.js');
const {
  normalizeAction,
  defaultDecision,
  resolveAUDN,
  normalizeConfidence,
  inferConflictConfidence,
  generateFallbackHeadline,
  normalizeExtractedEntities,
  normalizeExtractedRelations,
  EXTRACTION_PROMPT,
} = await import('../extraction.js');

type AUDNAction = Awaited<ReturnType<typeof normalizeAction>>;
const mockLlmChat = vi.mocked(llm.chat);

beforeEach(() => {
  mockLlmChat.mockReset();
});

describe('normalizeAction', () => {
  it('passes through valid uppercase actions', () => {
    const validActions: AUDNAction[] = ['ADD', 'UPDATE', 'DELETE', 'SUPERSEDE', 'NOOP', 'CLARIFY'];
    for (const action of validActions) {
      expect(normalizeAction(action)).toBe(action);
    }
  });

  it('normalizes lowercase to uppercase', () => {
    expect(normalizeAction('add')).toBe('ADD');
    expect(normalizeAction('update')).toBe('UPDATE');
    expect(normalizeAction('supersede')).toBe('SUPERSEDE');
  });

  it('normalizes mixed case', () => {
    expect(normalizeAction('Add')).toBe('ADD');
    expect(normalizeAction('Noop')).toBe('NOOP');
    expect(normalizeAction('Clarify')).toBe('CLARIFY');
  });

  it('trims whitespace', () => {
    expect(normalizeAction('  ADD  ')).toBe('ADD');
    expect(normalizeAction('\tDELETE\n')).toBe('DELETE');
  });

  it('defaults to ADD for unrecognized actions', () => {
    expect(normalizeAction('MERGE')).toBe('ADD');
    expect(normalizeAction('REPLACE')).toBe('ADD');
    expect(normalizeAction('')).toBe('ADD');
    expect(normalizeAction('garbage')).toBe('ADD');
  });
});

describe('defaultDecision', () => {
  it('returns ADD with null fields', () => {
    const decision = defaultDecision();
    expect(decision.action).toBe('ADD');
    expect(decision.targetMemoryId).toBeNull();
    expect(decision.updatedContent).toBeNull();
    expect(decision.clarificationNote).toBeNull();
    expect(decision.contradictionConfidence).toBeNull();
  });

  it('returns a fresh object each call', () => {
    const a = defaultDecision();
    const b = defaultDecision();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('resolveAUDN', () => {
  it('parses fenced Anthropic JSON responses', async () => {
    mockLlmChat.mockResolvedValueOnce(`\`\`\`json
{
  "action": "NOOP",
  "target_memory_id": "11111111-1111-4111-8111-111111111111",
  "updated_content": null,
  "clarification_note": null,
  "contradiction_confidence": null
}
\`\`\``);

    const decision = await resolveAUDN('User likes Vite.', [{
      id: '11111111-1111-4111-8111-111111111111',
      content: 'User likes Vite.',
      similarity: 0.99,
    }]);

    expect(decision.action).toBe('NOOP');
    expect(decision.targetMemoryId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('extracts JSON when the model includes prose around the object', async () => {
    mockLlmChat.mockResolvedValueOnce(`The answer is:
{
  "action": "ADD",
  "target_memory_id": null,
  "updated_content": null,
  "clarification_note": null,
  "contradiction_confidence": null
}
This is final.`);

    const decision = await resolveAUDN('User uses Supabase.', []);

    expect(decision).toEqual(defaultDecision());
  });

  it('requests a larger AUDN output budget for Anthropic-compatible models', async () => {
    mockLlmChat.mockResolvedValueOnce(JSON.stringify({
      action: 'ADD',
      target_memory_id: null,
      updated_content: null,
      clarification_note: null,
      contradiction_confidence: null,
    }));

    await resolveAUDN('User uses Tailwind.', []);

    expect(mockLlmChat).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({
      jsonMode: true,
      maxTokens: 2048,
      temperature: 0,
    }));
  });
});

describe('normalizeConfidence', () => {
  it('clamps valid numeric values to [0, 1]', () => {
    expect(normalizeConfidence(0.5, 'ADD', 'some fact')).toBe(0.5);
    expect(normalizeConfidence(0, 'ADD', 'some fact')).toBe(0);
    expect(normalizeConfidence(1, 'ADD', 'some fact')).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(normalizeConfidence(1.5, 'ADD', 'some fact')).toBe(1);
    expect(normalizeConfidence(-0.3, 'ADD', 'some fact')).toBe(0);
  });

  it('returns null for ADD/UPDATE/NOOP without numeric value', () => {
    expect(normalizeConfidence(null, 'ADD', 'some fact')).toBeNull();
    expect(normalizeConfidence(undefined, 'UPDATE', 'some fact')).toBeNull();
    expect(normalizeConfidence(null, 'NOOP', 'some fact')).toBeNull();
  });

  it('infers low confidence for CLARIFY without numeric value', () => {
    expect(normalizeConfidence(null, 'CLARIFY', 'some fact')).toBe(0.35);
  });

  it('infers high confidence for SUPERSEDE without numeric value', () => {
    expect(normalizeConfidence(null, 'SUPERSEDE', 'definite fact')).toBe(0.9);
  });

  it('infers high confidence for DELETE without numeric value', () => {
    expect(normalizeConfidence(null, 'DELETE', 'definite fact')).toBe(0.9);
  });

  it('infers low confidence for SUPERSEDE with uncertain language', () => {
    expect(normalizeConfidence(null, 'SUPERSEDE', 'I think this might be different')).toBe(0.35);
  });

  it('prefers explicit numeric value over inference', () => {
    expect(normalizeConfidence(0.7, 'CLARIFY', 'some fact')).toBe(0.7);
    expect(normalizeConfidence(0.8, 'SUPERSEDE', 'maybe wrong')).toBe(0.8);
  });

  it('treats NaN as missing', () => {
    expect(normalizeConfidence(NaN, 'ADD', 'some fact')).toBeNull();
  });

  it('treats Infinity as missing', () => {
    expect(normalizeConfidence(Infinity, 'ADD', 'some fact')).toBeNull();
  });
});

describe('inferConflictConfidence', () => {
  it('returns 0.35 when forceLow is true', () => {
    expect(inferConflictConfidence('definite statement', true)).toBe(0.35);
  });

  it('returns 0.9 for confident statements', () => {
    expect(inferConflictConfidence('User switched from Vim to VSCode', false)).toBe(0.9);
  });

  it('returns 0.35 for uncertain statements with "maybe"', () => {
    expect(inferConflictConfidence('maybe they use Go now', false)).toBe(0.35);
  });

  it('returns 0.35 for uncertain statements with "I think"', () => {
    expect(inferConflictConfidence('I think the project uses Rust', false)).toBe(0.35);
  });

  it('returns 0.35 for uncertain statements with "not sure"', () => {
    expect(inferConflictConfidence('User is not sure about the deadline', false)).toBe(0.35);
  });

  it('returns 0.35 for uncertain "might"', () => {
    expect(inferConflictConfidence('They might prefer Python', false)).toBe(0.35);
  });

  it('returns 0.35 for uncertain "perhaps"', () => {
    expect(inferConflictConfidence('Perhaps the team uses Jira', false)).toBe(0.35);
  });

  it('returns 0.35 for uncertain "guess"', () => {
    expect(inferConflictConfidence('I guess they switched databases', false)).toBe(0.35);
  });

  it('is case-insensitive for uncertainty markers', () => {
    expect(inferConflictConfidence('MAYBE they changed frameworks', false)).toBe(0.35);
    expect(inferConflictConfidence('I THINK it is different', false)).toBe(0.35);
  });
});

describe('generateFallbackHeadline', () => {
  it('returns short facts unchanged', () => {
    expect(generateFallbackHeadline('User prefers Vite')).toBe('User prefers Vite');
  });

  it('returns exactly 10-word facts unchanged', () => {
    const tenWords = 'one two three four five six seven eight nine ten';
    expect(generateFallbackHeadline(tenWords)).toBe(tenWords);
  });

  it('truncates facts longer than 10 words with ellipsis', () => {
    const longFact = 'one two three four five six seven eight nine ten eleven twelve';
    expect(generateFallbackHeadline(longFact)).toBe('one two three four five six seven eight nine ten...');
  });

  it('handles single-word facts', () => {
    expect(generateFallbackHeadline('Vite')).toBe('Vite');
  });

  it('handles empty string', () => {
    expect(generateFallbackHeadline('')).toBe('');
  });
});

describe('normalizeExtractedEntities', () => {
  it('extracts valid entities from array', () => {
    const input = [
      { name: 'PostgreSQL', type: 'tool' },
      { name: 'Jake', type: 'person' },
    ];
    const result = normalizeExtractedEntities(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'PostgreSQL', type: 'tool' });
    expect(result[1]).toEqual({ name: 'Jake', type: 'person' });
  });

  it('filters out entities with invalid type', () => {
    const input = [
      { name: 'Valid', type: 'tool' },
      { name: 'Invalid', type: 'widget' },
    ];
    expect(normalizeExtractedEntities(input)).toHaveLength(1);
  });

  it('filters out entities with empty name', () => {
    const input = [
      { name: '', type: 'tool' },
      { name: '  ', type: 'person' },
    ];
    expect(normalizeExtractedEntities(input)).toHaveLength(0);
  });

  it('trims entity names', () => {
    const input = [{ name: '  PostgreSQL  ', type: 'tool' }];
    expect(normalizeExtractedEntities(input)[0].name).toBe('PostgreSQL');
  });

  it('returns empty array for non-array input', () => {
    expect(normalizeExtractedEntities(null)).toEqual([]);
    expect(normalizeExtractedEntities(undefined)).toEqual([]);
    expect(normalizeExtractedEntities('string')).toEqual([]);
    expect(normalizeExtractedEntities(42)).toEqual([]);
  });

  it('accepts all valid entity types', () => {
    const types = ['person', 'tool', 'project', 'organization', 'place', 'concept'];
    const input = types.map((type) => ({ name: `Test-${type}`, type }));
    expect(normalizeExtractedEntities(input)).toHaveLength(6);
  });

  it('filters out entries missing name or type fields', () => {
    const input = [
      { name: 'Valid', type: 'tool' },
      { type: 'tool' },
      { name: 'NoType' },
      {},
      null,
    ];
    expect(normalizeExtractedEntities(input)).toHaveLength(1);
  });
});

describe('normalizeExtractedRelations', () => {
  it('extracts valid relations from array', () => {
    const input = [
      { source: 'Jake', target: 'PostgreSQL', type: 'uses' },
      { source: 'Jake', target: 'DataFlow', type: 'works_on' },
    ];
    const result = normalizeExtractedRelations(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ source: 'Jake', target: 'PostgreSQL', type: 'uses' });
  });

  it('filters out relations with invalid type', () => {
    const input = [
      { source: 'Jake', target: 'SQL', type: 'uses' },
      { source: 'Jake', target: 'SQL', type: 'hates' },
    ];
    expect(normalizeExtractedRelations(input)).toHaveLength(1);
  });

  it('filters out relations with empty source or target', () => {
    const input = [
      { source: '', target: 'Tool', type: 'uses' },
      { source: 'Jake', target: '', type: 'uses' },
    ];
    expect(normalizeExtractedRelations(input)).toHaveLength(0);
  });

  it('trims source and target names', () => {
    const input = [{ source: '  Jake  ', target: '  PostgreSQL  ', type: 'uses' }];
    const result = normalizeExtractedRelations(input);
    expect(result[0].source).toBe('Jake');
    expect(result[0].target).toBe('PostgreSQL');
  });

  it('returns empty array for non-array input', () => {
    expect(normalizeExtractedRelations(null)).toEqual([]);
    expect(normalizeExtractedRelations(undefined)).toEqual([]);
  });

  it('accepts all valid relation types', () => {
    const types = ['uses', 'works_on', 'works_at', 'located_in', 'knows',
      'prefers', 'created', 'belongs_to', 'studies', 'manages'];
    const input = types.map((type) => ({ source: 'A', target: 'B', type }));
    expect(normalizeExtractedRelations(input)).toHaveLength(10);
  });
});

describe('EXTRACTION_PROMPT — assistant-turn extraction directives', () => {
  it('instructs to extract factual content from assistant responses', () => {
    expect(EXTRACTION_PROMPT).toContain('DO extract specific factual content from assistant responses');
  });

  it('instructs to skip generic assistant chatter', () => {
    expect(EXTRACTION_PROMPT).toContain('Skip generic assistant chatter');
  });

  it('does NOT contain the old blanket skip-assistant instruction', () => {
    expect(EXTRACTION_PROMPT).not.toContain('Skip information the AI assistant stated');
    expect(EXTRACTION_PROMPT).not.toContain('extract only user-provided info');
  });
});
