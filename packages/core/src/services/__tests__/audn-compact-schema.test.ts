/**
 * AUDN must use an explicit JSON schema so am-local-slm does not route it
 * through the extraction-only core_extraction_schema grammar.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm.js', () => ({ llm: { chat: vi.fn() } }));
vi.mock('../../config.js', () => ({
  config: { audnMaxTokens: 128, extractionMaxTokens: 768, audnJsonSchema: false },
}));

const { llm } = await import('../llm.js');
const { config } = await import('../../config.js');
const { resolveAUDN, defaultDecision } = await import('../extraction.js');
const { AUDN_SCHEMA_NAME, audnChatOptions, audnJsonChatOptions } = await import('../extraction-json-schema.js');
const { openAIResponseFormat } = await import('../openai-chat-params.js');

const mockLlmChat = vi.mocked(llm.chat);
const TARGET_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  mockLlmChat.mockReset();
  (config as { audnJsonSchema: boolean }).audnJsonSchema = false;
});

describe('AUDN OpenAI / am-local-slm contract', () => {
  it('lists every property in required so OpenAI strict mode accepts the schema', () => {
    const schema = audnJsonChatOptions(128).jsonSchema?.schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const propertyNames = Object.keys(schema.properties);
    expect(schema.required).toEqual(propertyNames);
    expect(propertyNames).toEqual([
      'action',
      'target_memory_id',
      'updated_content',
      'clarification_note',
      'contradiction_confidence',
    ]);
  });

  it('selects json_schema from the capability flag, not the prompt variant', () => {
    expect(audnChatOptions(true, 128).jsonSchema?.name).toBe(AUDN_SCHEMA_NAME);
    expect(audnChatOptions(false, 128).jsonSchema).toBeUndefined();
  });

  it('emits json_schema so am-local-slm forwards the client grammar', () => {
    const options = audnJsonChatOptions(128);
    expect(openAIResponseFormat(true, options.jsonSchema)).toEqual({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: AUDN_SCHEMA_NAME,
          strict: true,
          schema: options.jsonSchema?.schema,
        },
      },
    });
  });
});

describe('resolveAUDN compact runtime contract', () => {
  it('sends core_audn json_schema on the full prompt when the provider flag is on', async () => {
    (config as { audnJsonSchema: boolean }).audnJsonSchema = true;
    mockLlmChat.mockResolvedValueOnce(JSON.stringify({
      action: 'NOOP',
      target_memory_id: TARGET_ID,
      updated_content: null,
      clarification_note: null,
      contradiction_confidence: null,
    }));

    await resolveAUDN('User likes Vite.', [{
      id: TARGET_ID,
      content: 'User likes Vite.',
      similarity: 0.99,
    }], 'full');

    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        jsonSchema: expect.objectContaining({ name: AUDN_SCHEMA_NAME, strict: true }),
      }),
    );
  });

  it('keeps compact+Groq on json_object when the provider flag is off', async () => {
    mockLlmChat.mockResolvedValueOnce(JSON.stringify({
      action: 'NOOP',
      target_memory_id: TARGET_ID,
      updated_content: null,
      clarification_note: null,
      contradiction_confidence: null,
    }));

    await resolveAUDN('User likes Vite.', [{
      id: TARGET_ID,
      content: 'User likes Vite.',
      similarity: 0.99,
    }], 'compact');

    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.any(Array),
      { temperature: 0, jsonMode: true, maxTokens: 128 },
    );
  });

  it('requests the core_audn schema and returns a non-ADD decision', async () => {
    (config as { audnJsonSchema: boolean }).audnJsonSchema = true;
    mockLlmChat.mockResolvedValueOnce(JSON.stringify({
      action: 'NOOP',
      target_memory_id: TARGET_ID,
      updated_content: null,
      clarification_note: null,
      contradiction_confidence: null,
    }));

    const decision = await resolveAUDN('User likes Vite.', [{
      id: TARGET_ID,
      content: 'User likes Vite.',
      similarity: 0.99,
    }], 'compact');

    expect(decision.action).toBe('NOOP');
    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('ACTIONS:'),
        }),
      ]),
      expect.objectContaining({
        jsonMode: true,
        maxTokens: 128,
        jsonSchema: expect.objectContaining({ name: AUDN_SCHEMA_NAME, strict: true }),
      }),
    );
  });

  it('does not silently default to ADD when json_object would return extraction shape', async () => {
    mockLlmChat.mockResolvedValueOnce(JSON.stringify({
      memories: [{ fact: 'User likes Vite.', type: 'preference' }],
    }));

    const decision = await resolveAUDN('User likes Vite.', [{
      id: TARGET_ID,
      content: 'User likes Vite.',
      similarity: 0.99,
    }], 'compact');

    expect(decision).toEqual(defaultDecision());
  });
});
