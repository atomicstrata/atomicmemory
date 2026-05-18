/**
 * @file Tests for fromModelMessage — lossy flattening of AI SDK v5
 *       content-part arrays into the SDK's string-content `Message`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromModelMessage, fromModelMessages } from './from-model-message.js';

test('passes through string content unchanged', () => {
  const m = fromModelMessage({ role: 'user', content: 'hello' });
  assert.deepEqual(m, { role: 'user', content: 'hello' });
});

test('concatenates text parts with newlines', () => {
  const m = fromModelMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'part one' },
      { type: 'text', text: 'part two' },
    ],
  });
  assert.equal(m.content, 'part one\npart two');
});

test('replaces images and files with placeholders', () => {
  const m = fromModelMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'see this:' },
      { type: 'image' },
      { type: 'file', filename: 'report.pdf' },
    ],
  });
  assert.equal(m.content, 'see this:\n[image]\n[file: report.pdf]');
});

test('serializes AI SDK v5 tool-call args and tool-result output as JSON', () => {
  const m = fromModelMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'lookup',
        args: { q: 'x' },
      },
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'lookup',
        output: { v: 42 },
      },
    ],
  });
  assert.match(m.content, /\[tool-call lookup id=call_1\] \{"q":"x"\}/);
  assert.match(m.content, /\[tool-result lookup id=call_1\] \{"v":42\}/);
});

test('tool-call without toolCallId still renders, omitting the id tag', () => {
  const m = fromModelMessage({
    role: 'assistant',
    content: [{ type: 'tool-call', toolName: 'lookup', args: { q: 'x' } }],
  });
  assert.equal(m.content, '[tool-call lookup] {"q":"x"}');
});

test('fromModelMessages maps an array', () => {
  const out = fromModelMessages([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ]);
});

test('falls back to a type tag for unknown part kinds', () => {
  const m = fromModelMessage({
    role: 'assistant',
    content: [{ type: 'reasoning' }],
  });
  assert.equal(m.content, '[reasoning]');
});
