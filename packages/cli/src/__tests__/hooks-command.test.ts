import test from 'node:test';
import assert from 'node:assert/strict';
import { hooks } from '../commands/setup/hooks/index.js';
import { CliError } from '../types.js';
import type { CommandContext } from '../commands/types.js';
import type {
  AdapterIngestInput,
  AdapterSearchInput,
  ProviderAdapter,
} from '../adapters/types.js';
import type { ProviderCapabilities } from '../types.js';

const capabilities: ProviderCapabilities = {
  ingestModes: ['text', 'verbatim'],
  extensions: { package: true },
};

function ctx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'hooks',
    positional: ['install'],
    flags: {},
    config: { schema_version: '2', activeProfile: 'default', profiles: {} },
    configPath: '/tmp/atomicmemory/config.json',
    configDir: '/tmp/atomicmemory',
    profile: null,
    scope: {},
    env: {},
    version: '0.1.0',
    readStdin: async () => '',
    experimental: false,
    getAdapter: async () => {
      throw new Error('adapter should not initialize for hooks install');
    },
    ...overrides,
  };
}

function adapter(overrides: Partial<ProviderAdapter>): ProviderAdapter {
  return {
    providerName: 'atomicmemory',
    initialize: async () => undefined,
    getStatus: async () => ({ ok: true, provider: 'atomicmemory' }),
    getCapabilities: async () => capabilities,
    addMemory: async () => ({ created: [], updated: [], unchanged: [] }),
    ingestMemories: async () => ({ created: [], updated: [], unchanged: [] }),
    searchMemories: async () => [],
    listMemories: async () => ({ memories: [] }),
    getMemory: async () => null,
    deleteMemory: async () => undefined,
    packageContext: async () => ({
      text: '',
      tokens: 0,
      hits: [],
      budgetConstrained: false,
    }),
    ...overrides,
  };
}

test('hooks install defaults to codex + node and emits runnable Codex config', async () => {
  const result = await hooks(ctx({}));

  assert.equal(result.command, 'hooks');
  const data = result.data as {
    host: string;
    runtime: string;
    runtimeTier: string;
    snippets: Array<{ content: string }>;
  };
  assert.equal(data.host, 'codex');
  assert.equal(data.runtime, 'node');
  assert.equal(data.runtimeTier, 'recommended');
  assert.match(data.snippets[0]?.content ?? '', /\[features\]/);
  assert.match(data.snippets[0]?.content ?? '', /codex_hooks = true/);
  assert.match(data.snippets[0]?.content ?? '', /atomicmemory hooks run user-prompt-submit --host codex/);
});

test('hooks install marks python as an advanced external runtime', async () => {
  const result = await hooks(ctx({
    flags: { runtime: 'python', host: 'claude-code' },
  }));

  const data = result.data as {
    host: string;
    runtime: string;
    runtimeTier: string;
    requiredEnv: string[];
    snippets: Array<{ language: string; content: string }>;
  };
  assert.equal(data.host, 'claude-code');
  assert.equal(data.runtime, 'python');
  assert.equal(data.runtimeTier, 'advanced');
  assert.ok(data.requiredEnv.some((name) => name.includes('ATOMICMEMORY_PYTHON_HOOK_BIN')));
  assert.equal(data.snippets[0]?.language, 'json');
  const snippet = JSON.parse(data.snippets[0]?.content ?? '{}') as {
    hooks?: { UserPromptSubmit?: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
  };
  const hook = snippet.hooks?.UserPromptSubmit?.[0]?.hooks[0];
  const command = hook?.command ?? '';
  assert.match(command, /^sh -c /);
  assert.match(command, /ATOMICMEMORY_PYTHON_HOOK_BIN is required/);
  assert.match(command, /python "\$ATOMICMEMORY_PYTHON_HOOK_BIN" user-prompt-submit --host claude-code/);
  assert.equal(hook?.timeout, 10);
});

test('hooks run rejects python because only node is bundled here', async () => {
  await assert.rejects(
    hooks(ctx({
      positional: ['run', 'user-prompt-submit'],
      flags: { runtime: 'python' },
    })),
    (err: unknown) => err instanceof CliError && err.code === 'usage',
  );
});

test('hooks run user-prompt-submit searches memories and emits hook JSON', async () => {
  const searches: AdapterSearchInput[] = [];
  const result = await hooks(ctx({
    positional: ['run', 'user-prompt-submit'],
    flags: { limit: 3 },
    scope: { user: 'u1', namespace: 'docs' },
    readStdin: async () => JSON.stringify({
      prompt: 'Please continue the implementation plan for lifecycle hooks.',
    }),
    getAdapter: async () => ({
      capabilities,
      adapter: adapter({
        searchMemories: async (input) => {
          searches.push(input);
          return [
            {
              score: 0.9,
              memory: {
                id: 'mem_1',
                content: 'Prefer the bundled Node hook runtime by default.',
                scope: { user: 'u1', namespace: 'docs' },
                createdAt: '2026-05-09T00:00:00.000Z',
              },
            },
          ];
        },
      }),
    }),
  }));

  assert.equal(result.command, 'hooks');
  assert.equal(result.count, 1);
  assert.deepEqual(searches[0]?.scope, { user: 'u1', namespace: 'docs' });
  assert.equal(searches[0]?.limit, 3);

  // Hook data shape is now a structured object; the host-wire
  // compact JSON is derived in text mode via meta.host_text_format.
  const payload = result.data as {
    hookSpecificOutput: {
      hookEventName: string;
      additionalContext: string;
    };
  };
  assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(payload.hookSpecificOutput.additionalContext, /bundled Node hook runtime/);
  assert.equal(
    (result.meta as Record<string, unknown> | undefined)?.host_text_format,
    'compact-json',
  );
});

test('hooks run user-prompt-submit reports prompt_too_short without adapter init', async () => {
  const result = await hooks(ctx({
    positional: ['run', 'user-prompt-submit'],
    readStdin: async () => JSON.stringify({ prompt: 'too short' }),
  }));

  assert.equal(result.count, 0);
  assert.deepEqual(result.meta, {
    action: 'run',
    skipped: true,
    reason: 'prompt_too_short',
  });
});

test('hooks run user-prompt-submit reports no_hits after empty search', async () => {
  const result = await hooks(ctx({
    positional: ['run', 'user-prompt-submit'],
    scope: { user: 'u1' },
    readStdin: async () => JSON.stringify({
      prompt: 'Please continue implementing the lifecycle hook runtime option.',
    }),
    getAdapter: async () => ({
      capabilities,
      adapter: adapter({ searchMemories: async () => [] }),
    }),
  }));

  assert.equal(result.count, 0);
  assert.deepEqual(result.meta, {
    action: 'run',
    skipped: true,
    reason: 'no_hits',
  });
});

test('hooks run post-compact ingests a verbatim summary with provenance', async () => {
  const ingests: AdapterIngestInput[] = [];
  const result = await hooks(ctx({
    positional: ['run', 'post-compact'],
    scope: { user: 'u1', thread: 'thread-1' },
    readStdin: async () => JSON.stringify({
      compact_summary: 'Implemented runtime selection for AtomicMemory hooks.',
    }),
    getAdapter: async () => ({
      capabilities,
      adapter: adapter({
        ingestMemories: async (input) => {
          ingests.push(input);
          return { created: ['mem_2'], updated: [], unchanged: [] };
        },
      }),
    }),
  }));

  assert.equal(result.command, 'hooks');
  assert.equal(result.count, 1);
  assert.equal(ingests[0]?.mode, 'verbatim');
  assert.equal(ingests[0]?.kind, 'summary');
  assert.equal(ingests[0]?.metadata?.event, 'post_compact');
  assert.match(ingests[0]?.provenance?.sourceUrl ?? '', /^atomicmemory:\/\/codex\/post-compact\//);
});

test('hooks run stop ingests the last assistant response', async () => {
  const ingests: AdapterIngestInput[] = [];
  const assistantResponse =
    'Implemented the dashboard review follow-up: refactored the loader, '
    + 'tightened the hooks event dispatcher, added focused tests for the '
    + 'sanitizer port, and confirmed the install snippet still emits the '
    + 'documented Codex+claude-code matrix end-to-end.';
  const result = await hooks(ctx({
    positional: ['run', 'stop'],
    flags: { host: 'claude-code' },
    scope: { user: 'u1', namespace: 'agent-session' },
    readStdin: async () => JSON.stringify({ assistantResponse }),
    getAdapter: async () => ({
      capabilities,
      adapter: adapter({
        ingestMemories: async (input) => {
          ingests.push(input);
          return { created: [], updated: ['mem_3'], unchanged: [] };
        },
      }),
    }),
  }));

  assert.equal(result.command, 'hooks');
  assert.equal(result.count, 1);
  assert.equal(ingests[0]?.mode, 'verbatim');
  assert.equal(ingests[0]?.text, assistantResponse);
  assert.equal(ingests[0]?.metadata?.event, 'stop');
  assert.match(ingests[0]?.provenance?.sourceUrl ?? '', /^atomicmemory:\/\/claude-code\/stop\//);
});

test('hooks run stop reports no_content without adapter init', async () => {
  const result = await hooks(ctx({
    positional: ['run', 'stop'],
    readStdin: async () => JSON.stringify({}),
  }));

  assert.equal(result.count, 0);
  assert.deepEqual(result.meta, {
    action: 'run',
    skipped: true,
    reason: 'no_content',
  });
});

test('hooks dedupe keys are stable across scope property order', async () => {
  const keys: unknown[] = [];
  // Lower the stop low-signal threshold so the short fixture content
  // actually reaches ingestMemories — at the default 200-char gate
  // this test would short-circuit and pass vacuously with two
  // `undefined` keys.
  const env = { ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS: '5' };
  for (const scope of [
    { user: 'u1', namespace: 'agent-session' },
    { namespace: 'agent-session', user: 'u1' },
  ]) {
    await hooks(ctx({
      positional: ['run', 'stop'],
      scope,
      env,
      readStdin: async () => JSON.stringify({ message: 'Same assistant response.' }),
      getAdapter: async () => ({
        capabilities,
        adapter: adapter({
          ingestMemories: async (input) => {
            keys.push(input.metadata?.dedupe_key);
            return { created: ['mem'], updated: [], unchanged: [] };
          },
        }),
      }),
    }));
  }

  assert.equal(keys.length, 2, 'both invocations must reach ingestMemories');
  assert.equal(typeof keys[0], 'string');
  assert.equal(typeof keys[1], 'string');
  assert.equal(keys[0], keys[1]);
});

test('hooks run post-compact sanitizes <analysis>, secrets, and follow-up prompts before ingest', async () => {
  const ingests: AdapterIngestInput[] = [];
  const compactInput = [
    '<analysis>private reasoning we MUST drop sk-AAAAAAAAAAAAAAAA1234</analysis>',
    '<summary>Implemented the runtime selection step.',
    '```ts',
    'const noisy = "code goes away";',
    '```',
    'Want me to also add docs?',
    '</summary>',
  ].join('\n');

  await hooks(ctx({
    positional: ['run', 'post-compact'],
    scope: { user: 'u1' },
    readStdin: async () => JSON.stringify({ compact_summary: compactInput }),
    getAdapter: async () => ({
      capabilities,
      adapter: adapter({
        ingestMemories: async (input) => {
          ingests.push(input);
          return { created: ['mem_pc'], updated: [], unchanged: [] };
        },
      }),
    }),
  }));

  const stored = ingests[0]?.text ?? '';
  assert.match(stored, /Implemented the runtime selection step/);
  assert.equal(/private reasoning/.test(stored), false);
  assert.equal(/sk-AAAAAAAAAAAAAAAA1234/.test(stored), false);
  assert.equal(/code goes away/.test(stored), false);
  assert.equal(/Want me to/.test(stored), false);
});

test('hooks run stop short-circuits with low_signal at the default 200-char threshold', async () => {
  let getAdapterCalls = 0;
  const result = await hooks(ctx({
    positional: ['run', 'stop'],
    scope: { user: 'u1' },
    readStdin: async () => JSON.stringify({ assistant_response: 'short reply' }),
    getAdapter: async () => {
      getAdapterCalls += 1;
      throw new Error('low_signal must short-circuit before getAdapter');
    },
  }));

  assert.deepEqual(result.meta, { action: 'run', skipped: true, reason: 'low_signal' });
  assert.equal(getAdapterCalls, 0);
});

test('hooks run stop accepts shorter content when ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS lowers the gate', async () => {
  const ingests: AdapterIngestInput[] = [];
  const result = await hooks(ctx({
    positional: ['run', 'stop'],
    scope: { user: 'u1' },
    env: { ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS: '5' },
    readStdin: async () => JSON.stringify({ assistant_response: 'short reply' }),
    getAdapter: async () => ({
      capabilities,
      adapter: adapter({
        ingestMemories: async (input) => {
          ingests.push(input);
          return { created: ['mem_stop'], updated: [], unchanged: [] };
        },
      }),
    }),
  }));

  assert.equal(result.count, 1);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0]?.text, 'short reply');
});

test('hooks run stop redacts secrets in the ingested assistant content', async () => {
  const ingests: AdapterIngestInput[] = [];
  const longSafeContent = 'Reviewed the patch and confirmed it correctly enforces the new trust-surface contract; '
    + 'verified the gates now fail closed and updated the documentation accordingly.';
  const stdinPayload = `${longSafeContent} The leaked key sk-DEADBEEF0123456789ABC must be removed.`;

  await hooks(ctx({
    positional: ['run', 'stop'],
    scope: { user: 'u1' },
    readStdin: async () => JSON.stringify({ assistant_response: stdinPayload }),
    getAdapter: async () => ({
      capabilities,
      adapter: adapter({
        ingestMemories: async (input) => {
          ingests.push(input);
          return { created: ['mem_redact'], updated: [], unchanged: [] };
        },
      }),
    }),
  }));

  const stored = ingests[0]?.text ?? '';
  assert.equal(/sk-DEADBEEF0123456789ABC/.test(stored), false);
  assert.match(stored, /sk-\[redacted\]/);
});
