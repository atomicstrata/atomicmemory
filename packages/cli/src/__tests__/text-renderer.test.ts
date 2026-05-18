/**
 * @file Text renderer unit tests. Covers the v5 contract that
 * `renderTextSuccess` does NOT emit a trailing newline when the
 * command result's `data` is empty — generated hook commands rely on
 * this so default text-mode skips (`prompt_too_short`, `no_content`,
 * `no_hits`, `low_signal`) and lifecycle-write success cases produce
 * truly silent stdout instead of a stray blank line that would inject
 * an empty turn into Claude Code / Codex transcripts. Machine modes
 * (json/agent) are unaffected and surface `meta.reason` independently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTextSuccess } from '../renderers/text.js';
import type { CommandResult, RenderContext } from '../types.js';

const ctx: RenderContext = {
  mode: 'text',
  interactive: false,
  profileName: 'default',
  startTime: 0,
  command: 'hooks',
  color: false,
};

function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('renderTextSuccess writes nothing when data is an empty string (hook skip / lifecycle success)', () => {
  const result: CommandResult<string> = { command: 'hooks', data: '', count: 0 };
  const out = captureStdout(() => renderTextSuccess(ctx, result));
  assert.equal(out, '');
});

test('renderTextSuccess writes nothing when data is null', () => {
  const result: CommandResult<null> = { command: 'hooks', data: null, count: 0 };
  const out = captureStdout(() => renderTextSuccess(ctx, result));
  assert.equal(out, '');
});

test('renderTextSuccess writes the string + trailing newline for non-empty string data', () => {
  const result: CommandResult<string> = { command: 'completion', data: 'hello world', count: 1 };
  const out = captureStdout(() => renderTextSuccess(ctx, result));
  assert.equal(out, 'hello world\n');
});

test('renderTextSuccess pretty-prints object data with a trailing newline', () => {
  const result: CommandResult<{ id: string }> = {
    command: 'add',
    data: { id: 'mem_1' },
    count: 1,
  };
  const out = captureStdout(() => renderTextSuccess(ctx, result));
  assert.equal(out, '{\n  "id": "mem_1"\n}\n');
});

test('renderTextSuccess emits progress events even when data is empty', () => {
  const result: CommandResult<string> = {
    command: 'hooks',
    data: '',
    count: 0,
    events: [{ type: 'info', message: 'starting' }],
  };
  const out = captureStdout(() => renderTextSuccess(ctx, result));
  assert.equal(out, '[info] starting\n');
});

test('renderTextSuccess honors meta.host_text_format compact-json for hook user-prompt-submit', () => {
  // Hook host (Claude Code / Codex) parses stdout as a single compact
  // JSON line. The text renderer must emit the equivalent compact JSON
  // when the hook command sets meta.host_text_format = 'compact-json',
  // not the pretty 2-space-indented form used by other commands.
  const result: CommandResult<{ hookSpecificOutput: { hookEventName: string; additionalContext: string } }> = {
    command: 'hooks',
    data: {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '## Relevant prior context',
      },
    },
    count: 1,
    meta: { host_text_format: 'compact-json' },
  };
  const out = captureStdout(() => renderTextSuccess(ctx, result));
  // Single line, no pretty-print indentation.
  assert.equal(out.endsWith('\n'), true);
  const parsed = JSON.parse(out.trim()) as {
    hookSpecificOutput: { hookEventName: string };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.includes('\n  '), false, 'expected compact JSON, not pretty-printed');
});

test('renderTextSuccess writes nothing when host_text_format is set but data is empty', () => {
  const result: CommandResult<string> = {
    command: 'hooks',
    data: '',
    count: 0,
    meta: { host_text_format: 'compact-json' },
  };
  const out = captureStdout(() => renderTextSuccess(ctx, result));
  assert.equal(out, '');
});
