/**
 * @file v5 input precedence: file > positional content > stdin.
 *   - `add`: --file beats a positional text arg
 *   - `ingest`: positional text beats --stdin
 * The earlier ordering let an agent that piped data and also passed a
 * literal positional silently use the pipe; v5 requires the literal
 * to win.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add } from '../commands/memory/add.js';
import { ingest } from '../commands/memory/ingest.js';
import { emptyConfig } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';
import type { AdapterIngestInput } from '../adapters/types.js';

interface AdapterCalls {
  add: { text: string }[];
  ingest: AdapterIngestInput[];
}

function makeAdapterStub(calls: AdapterCalls): CommandContext['getAdapter'] {
  return async () => ({
    adapter: {
      addMemory: async (input: { text: string }) => {
        calls.add.push({ text: input.text });
        return { created: ['id-1'], updated: [], unchanged: [] };
      },
      ingestMemories: async (input: AdapterIngestInput) => {
        calls.ingest.push(input);
        return { created: ['id-2'], updated: [], unchanged: [] };
      },
    } as never,
    capabilities: { ingestModes: ['text'], extensions: { package: false } },
  });
}

function makeCtx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'add',
    positional: [],
    flags: {},
    config: emptyConfig(),
    configPath: '/tmp/missing/config.json',
    configDir: '/tmp/missing',
    profile: null,
    scope: { user: 'u' },
    env: {},
    version: '0.1.0',
    readStdin: async () => '',
    experimental: false,
    getAdapter: async () => {
      throw new Error('test must inject getAdapter');
    },
    ...overrides,
  };
}

test('add: --file <path> wins over a positional text arg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomicmem-input-prec-'));
  const filePath = join(dir, 'note.txt');
  writeFileSync(filePath, 'from-file-content');
  try {
    const calls: AdapterCalls = { add: [], ingest: [] };
    const ctx = makeCtx({
      positional: ['from', 'positional'],
      flags: { file: filePath },
      getAdapter: makeAdapterStub(calls),
    });
    await add(ctx);
    assert.equal(calls.add.length, 1);
    assert.equal(calls.add[0]!.text, 'from-file-content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingest: positional content wins over --stdin', async () => {
  const calls: AdapterCalls = { add: [], ingest: [] };
  const ctx = makeCtx({
    command: 'ingest',
    positional: ['from', 'positional'],
    flags: { mode: 'text', stdin: true },
    readStdin: async () => 'from-stdin',
    getAdapter: makeAdapterStub(calls),
  });
  await ingest(ctx);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0]!.mode, 'text');
  assert.equal(calls.ingest[0]!.text, 'from positional');
});

test('ingest: --stdin still works as the last-resort fallback when no positional given', async () => {
  const calls: AdapterCalls = { add: [], ingest: [] };
  const ctx = makeCtx({
    command: 'ingest',
    positional: [],
    flags: { mode: 'text', stdin: true },
    readStdin: async () => 'fallback-stdin\n',
    getAdapter: makeAdapterStub(calls),
  });
  await ingest(ctx);
  assert.equal(calls.ingest[0]!.text, 'fallback-stdin');
});
