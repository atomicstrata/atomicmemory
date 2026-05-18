import { describe, expect, it } from 'vitest';
import {
  buildEntityCardMessages,
  buildReflectMessages,
  REFLECT_TOOL_SCHEMA,
} from '../reflect-prompts.js';

describe('reflect-prompts', () => {
  it('REFLECT_TOOL_SCHEMA defines record_observations with required fields', () => {
    expect(REFLECT_TOOL_SCHEMA.name).toBe('record_observations');
    const props = REFLECT_TOOL_SCHEMA.input_schema.properties;
    expect(props).toBeDefined();
    expect(props.observations).toBeDefined();
    expect(props.observations.type).toBe('array');
    const items = props.observations.items;
    expect(items.required).toEqual(expect.arrayContaining(['text', 'type', 'evidence_memory_ids']));
    expect(items.properties.type.enum).toEqual(expect.arrayContaining([
      'entity_state', 'event_summary', 'preference',
      'contradiction', 'decision', 'numeric_value',
    ]));
  });

  it('buildReflectMessages includes each memory id and observation type list', () => {
    const memories = [
      { id: 'm1', text: 'User uses Flask 2.3', observedAt: new Date('2026-03-01') },
      { id: 'm2', text: 'User never used Flask',  observedAt: new Date('2026-03-15') },
    ];
    const { system, user } = buildReflectMessages(memories);
    expect(system).toContain('observations');
    expect(user).toContain('m1');
    expect(user).toContain('m2');
    expect(user).toContain('User uses Flask 2.3');
    expect(user).toContain('User never used Flask');
  });

  describe('buildEntityCardMessages', () => {
    it('includes entity name in system prompt and obs lines in user prompt', () => {
      const obs = [
        { id: 'o1', text: 'User uses Flask 3.1', observedAt: new Date('2026-03-01') },
        { id: 'o2', text: 'User prefers Python', observedAt: new Date('2026-03-02') },
      ];
      const { system, user } = buildEntityCardMessages('user', null, obs);
      expect(system).toContain('"user"');
      expect(system).toContain('250 tokens');
      expect(user).toContain('(none)');
      expect(user).toContain('[o1]');
      expect(user).toContain('[o2]');
      expect(user).toContain('User uses Flask 3.1');
      expect(user).toContain('Output ONLY the updated card text');
    });

    it('includes prior card text when provided', () => {
      const obs = [
        { id: 'o1', text: 'User uses Flask 3.1', observedAt: new Date('2026-03-01') },
      ];
      const { user } = buildEntityCardMessages('user', 'identity: Alice', obs);
      expect(user).toContain('identity: Alice');
      expect(user).not.toContain('(none)');
    });
  });
});
