import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiWordmarkRows, renderGeminiWordmark, wordmarkLines, wordmarkSpacingForWidth } from './style.js';

test('renderGeminiWordmark does not emit ANSI in non-TTY output', () => {
  const wordmark = renderGeminiWordmark('ATOMICMEMORY', 0);

  assert.doesNotMatch(wordmark, /\u001b\[[0-9;]*m/);
  assert.match(wordmark, /█/);
});

test('gemini wordmark uses white fill and logo-blue shadow', () => {
  const rows = geminiWordmarkRows('A', 1, true).flat();

  assert.ok(rows.some((cell) => cell.tone === 'fill' && cell.color === '#ffffff'));
  assert.ok(rows.some((cell) => cell.tone === 'shadow' && cell.color === '#3a60e4'));
});

test('gemini wordmark keeps shadow close to the fill', () => {
  const rows = geminiWordmarkRows('I', 1, true);

  assert.equal(rows[1]?.[1]?.tone, 'shadow');
  assert.equal(rows[1]?.[1]?.char, '▀');
});

test('wordmark uses wider glyph shapes', () => {
  const [top, stem] = wordmarkLines('T', 1);

  assert.equal(top, '██████');
  assert.equal(stem, '  ██');
});

test('full wordmark fits within a default terminal width with compact spacing', () => {
  const lines = renderGeminiWordmark('ATOMICMEMORY', 0, true)
    .split('\n')
    .map(stripAnsi);

  assert.ok(Math.max(...lines.map((line) => line.length)) <= 80);
});

test('wordmark spacing expands only when the terminal has room', () => {
  assert.equal(wordmarkSpacingForWidth(80), 0);
  assert.equal(wordmarkSpacingForWidth(90), 1);
});

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
