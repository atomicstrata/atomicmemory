/**
 * Unit tests for transcript session-date parsing.
 */

import { describe, expect, it } from 'vitest';
import { extractSessionTimestamp, parseSessionDate, resolveSessionDate } from '../session-date.js';

describe('session-date helpers', () => {
  it('extracts the first-line session timestamp', () => {
    const timestamp = extractSessionTimestamp('[Session date: 2023-08-14T10:00:00Z]\nUser: hello');

    expect(timestamp).toBe('2023-08-14T10:00:00Z');
  });

  it('parses valid session dates', () => {
    const parsed = parseSessionDate('[Session date: 2023-08-14]\nUser: hello');

    expect(parsed?.toISOString()).toBe('2023-08-14T00:00:00.000Z');
  });

  it('prefers explicit timestamps over transcript headers', () => {
    const explicit = new Date('2026-01-01T00:00:00.000Z');
    const resolved = resolveSessionDate(explicit, '[Session date: 2023-08-14]\nUser: hello');

    expect(resolved).toBe(explicit);
  });

  it('parses BEAM-style time anchor with Turn marker', () => {
    const parsed = parseSessionDate('[March-15-2024 | Turn 0] User: hello');
    expect(parsed?.toISOString().slice(0, 10)).toBe('2024-03-15');
  });

  it('parses BEAM-style time anchor without Turn marker', () => {
    const parsed = parseSessionDate('[April-10-2024] User: hello');
    expect(parsed?.toISOString().slice(0, 10)).toBe('2024-04-10');
  });

  it('returns null when first line is plain content', () => {
    const parsed = parseSessionDate('User: hello there');
    expect(parsed).toBeNull();
  });

  it('Session-date header still wins over BEAM anchor', () => {
    const parsed = parseSessionDate('[Session date: 2023-08-14]\n[March-15-2024 | Turn 0] User: hi');
    expect(parsed?.toISOString().slice(0, 10)).toBe('2023-08-14');
  });
});

describe('rejects bare turn markers as session dates (sprint-4 bugfix)', () => {
  it('rejects [Turn 43] (avoids Date.parse → 2043)', () => {
    expect(parseSessionDate('[Turn 43] User: hello')).toBeNull();
  });

  it('rejects [Turn 97] (avoids Date.parse → 1997)', () => {
    expect(parseSessionDate('[Turn 97] User: hello')).toBeNull();
  });

  it('rejects [Turn 134] (avoids Date.parse → 0134)', () => {
    expect(parseSessionDate('[Turn 134] User: hello')).toBeNull();
  });

  it('still accepts [March-15-2024 | Turn 0]', () => {
    const d = parseSessionDate('[March-15-2024 | Turn 0] User: hello');
    expect(d?.toISOString().slice(0,10)).toBe('2024-03-15');
  });

  it('still accepts [Session date: 2024-04-25]', () => {
    const d = parseSessionDate('[Session date: 2024-04-25]\nUser: hello');
    expect(d?.toISOString().slice(0,10)).toBe('2024-04-25');
  });

  it('rejects [code block] non-date capture', () => {
    expect(parseSessionDate('[code block] some code')).toBeNull();
  });
});
