import { describe, expect, it } from 'vitest';
import { extractEntityAttributes, EntityAttributeExtractorError } from '../entity-attribute-extractor.js';
import type { ChatMessage, LLMProvider } from '../llm.js';

function stub(reply: string): LLMProvider {
  return { async chat(_m: ChatMessage[]) { return reply; } } as unknown as LLMProvider;
}

describe('extractEntityAttributes', () => {
  it('parses valid triples', async () => {
    const llm = stub(JSON.stringify({
      triples: [
        { entity_name: 'problems', attribute_key: 'count', attribute_value: '25', value_type: 'number' },
        { entity_name: 'app', attribute_key: 'features', attribute_value: 'A,B,C', value_type: 'list' },
      ],
    }));
    const out = await extractEntityAttributes('I completed 25 problems...', llm);
    expect(out.length).toBe(2);
    expect(out[0].entityName).toBe('problems');
    expect(out[0].valueType).toBe('number');
    expect(out[1].attributeKey).toBe('features');
  });

  it('drops triples with invalid value_type', async () => {
    const llm = stub(JSON.stringify({
      triples: [
        { entity_name: 'x', attribute_key: 'y', attribute_value: 'z', value_type: 'INVALID' },
        { entity_name: 'a', attribute_key: 'b', attribute_value: 'c', value_type: 'number' },
      ],
    }));
    const out = await extractEntityAttributes('text', llm);
    expect(out.length).toBe(1);
    expect(out[0].entityName).toBe('a');
  });

  it('drops triples with missing fields', async () => {
    const llm = stub(JSON.stringify({
      triples: [
        { entity_name: '', attribute_key: 'k', attribute_value: 'v', value_type: 'string' },
        { entity_name: 'x', attribute_value: 'v', value_type: 'string' },
        { entity_name: 'ok', attribute_key: 'ok', attribute_value: 'ok', value_type: 'string' },
      ],
    }));
    const out = await extractEntityAttributes('text', llm);
    expect(out.length).toBe(1);
  });

  it('throws on empty input', async () => {
    await expect(extractEntityAttributes('', stub('{}'))).rejects.toBeInstanceOf(EntityAttributeExtractorError);
  });

  it('throws on non-JSON LLM response', async () => {
    await expect(extractEntityAttributes('text', stub('not json'))).rejects.toBeInstanceOf(EntityAttributeExtractorError);
  });

  it('throws when triples field is missing', async () => {
    await expect(extractEntityAttributes('text', stub('{"other": []}'))).rejects.toBeInstanceOf(EntityAttributeExtractorError);
  });
});
