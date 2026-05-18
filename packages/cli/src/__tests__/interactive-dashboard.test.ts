import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../cli/parse-invocation.js';
import { splitShellWords } from '../cli/shell-words.js';
import {
  commandForSubmittedMenuInput,
  commandMenuItems,
  commandMenuReservedRows,
  formatDashboardCommandResult,
  interactiveHelpText,
  sanitizeCapturedDashboardWrites,
  sessionBodyHeightForTerminal,
  sessionScrollOffset,
  wrapSessionLine,
} from '../renderers/ink/dashboard.js';
import {
  createInteractiveRuntimeSession,
  mergeInteractiveFlags,
} from '../cli/interactive-session.js';
import {
  resolveRuntimeProfile,
  resolveRuntimeScope,
  shouldLaunchDashboard,
  type RuntimeState,
} from '../cli/runtime.js';

test('splitShellWords supports quoted dashboard command input', () => {
  assert.deepEqual(splitShellWords('search "release policy" --namespace docs'), [
    'search',
    'release policy',
    '--namespace',
    'docs',
  ]);
});

test('splitShellWords supports escapes, single quotes, and unclosed quote errors', () => {
  assert.deepEqual(splitShellWords("add user\\ likes\\ fries --source 'manual note'"), [
    'add',
    'user likes fries',
    '--source',
    'manual note',
  ]);
  assert.throws(() => splitShellWords('search "release policy'), /Unclosed " quote/);
});

test('parseInvocation marks bare help source for dashboard launch', async () => {
  const parsed = await parseInvocation([]);

  assert.equal(parsed.error, null);
  assert.equal(parsed.invocation?.path, 'help');
  assert.equal(parsed.invocation?.source, 'bare');
});

test('dashboard slash menu prefers help and filters direct commands', () => {
  assert.equal(commandMenuItems('/')[0]?.command, '/help');
  assert.deepEqual(
    commandMenuItems('/').map((item) => item.command),
    [
      '/help',
      'doctor',
      'status',
      'validate',
      'skill get core',
      'config show',
      'search ',
      'add ',
      'package ',
      'list',
    ],
  );
  assert.deepEqual(
    commandMenuItems('/skill').map((item) => item.command),
    ['skill get core'],
  );
});

test('commandForSubmittedMenuInput selects highlighted item without recomputing the menu', () => {
  const items = commandMenuItems('/');

  assert.equal(commandForSubmittedMenuInput('/', 0, items), '/help');
  assert.equal(commandForSubmittedMenuInput('/', 1, items), 'doctor');
});

test('shouldLaunchDashboard only launches for bare or explicit interactive invocations', () => {
  assert.equal(shouldLaunchDashboard({ path: 'help', positional: [], flags: {}, source: 'bare' }), true);
  assert.equal(shouldLaunchDashboard({ path: 'doctor', positional: [], flags: { interactive: true } }), true);
  assert.equal(shouldLaunchDashboard({ path: 'help', positional: [], flags: {}, source: 'help_flag' }), false);
  assert.equal(shouldLaunchDashboard({ path: 'doctor', positional: [], flags: {} }), false);
});

test('bare dashboard hydrates saved profile and scope for cached commands', () => {
  const config = sessionConfig('user-from-profile');
  const invocation = { path: 'help', positional: [], flags: {}, source: 'bare' } as const;
  const profile = resolveRuntimeProfile(invocation, config, 'default', {});
  const scope = resolveRuntimeScope(invocation, profile, {});

  assert.equal(profile?.provider, 'atomicmemory');
  assert.equal(profile?.apiUrl, 'http://localhost:3050');
  assert.deepEqual(scope, { user: 'user-from-profile' });
});

test('plain help stays provider-free outside dashboard mode', () => {
  const config = sessionConfig('user-from-profile');
  const invocation = { path: 'help', positional: [], flags: {}, source: 'help_flag' } as const;
  const profile = resolveRuntimeProfile(invocation, config, 'default', {});
  const scope = resolveRuntimeScope(invocation, profile, {});

  assert.equal(profile, null);
  assert.deepEqual(scope, {});
});

test('mergeInteractiveFlags inherits only profile, provider, scope, and config flags', () => {
  const merged = mergeInteractiveFlags(
    {
      agent: true,
      'api-url': 'http://localhost:3050',
      json: true,
      namespace: 'testing',
      output: 'quiet',
      profile: 'local',
      provider: 'atomicmemory',
      user: 'user-1',
    },
    { limit: 5 },
  );

  assert.deepEqual(merged, {
    'api-url': 'http://localhost:3050',
    interactive: false,
    limit: 5,
    namespace: 'testing',
    profile: 'local',
    provider: 'atomicmemory',
    user: 'user-1',
  });
});

test('interactive runtime session rejects stdin and output-shaping prompt commands', async () => {
  const runner = createInteractiveRuntimeSession({
    baseState: dashboardRuntimeState(),
    buildRuntimeContext: () => assert.fail('stdin/output rejections must happen before handler context'),
    createInitialState: dashboardRuntimeState,
    enforceRuntimeGates: () => {},
    parentInvocation: { path: 'help', positional: [], flags: {}, source: 'bare' },
    prepareRuntimeState: async () => assert.fail('stdin/output rejections must happen before prepare'),
    version: '0.1.0',
  });

  await assert.rejects(() => runner('add --stdin'), /cannot read stdin inside the interactive dashboard/);
  await assert.rejects(() => runner('status --json'), /remove --json, --agent, or --output/);
});

test('interactive runtime session refreshes cached state after config mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomicmemory-cli-session-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(sessionConfig('user-old'), null, 2));
  let prepareCalls = 0;

  try {
    const runner = createInteractiveRuntimeSession({
      baseState: sessionState(file, dir, 'user-old'),
      buildRuntimeContext: ({ state, invocation, stdin, version }) => ({
        command: invocation.path,
        positional: invocation.positional,
        flags: invocation.flags,
        config: state.config,
        configPath: state.paths.file,
        configDir: state.paths.dir,
        profile: state.profile,
        scope: state.scope,
        env: {},
        version,
        readStdin: () => stdin.read(),
        experimental: false,
        getAdapter: async () => ({ adapter: statusAdapter(), capabilities: statusCapabilities() }),
      }),
      createInitialState: dashboardRuntimeState,
      enforceRuntimeGates: () => {},
      parentInvocation: { path: 'help', positional: [], flags: { config: file }, source: 'bare' },
      prepareRuntimeState: async (state) => {
        prepareCalls += 1;
        Object.assign(state, sessionState(file, dir));
      },
      version: '0.1.0',
    });

    await runner('config set profiles.default.scope.user user-new');
    const result = await runner('status');

    assert.equal((result.data as { scope: { user?: string } }).scope.user, 'user-new');
    assert.equal(prepareCalls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interactiveHelpText documents dashboard scroll controls', () => {
  const help = interactiveHelpText();

  assert.match(help, /\/help/);
  assert.match(help, /Up \/ Down\s+scroll session output/);
  assert.match(help, /PageUp \/ PageDown/);
});

test('sessionBodyHeightForTerminal leaves room for bottom prompt and menu', () => {
  assert.equal(sessionBodyHeightForTerminal(24), 9);
  assert.equal(sessionBodyHeightForTerminal(32), 15);
  assert.equal(sessionBodyHeightForTerminal(40), 15);
  assert.equal(commandMenuReservedRows(commandMenuItems('/').length, false), 14);
  assert.equal(commandMenuReservedRows(commandMenuItems('/').length, true), 13);
  assert.equal(sessionBodyHeightForTerminal(24, true, true, commandMenuReservedRows(10, true)), 3);
  assert.equal(sessionBodyHeightForTerminal(60, false, false, commandMenuReservedRows(10, false)), 21);
});

test('sessionScrollOffset follows latest output across growing command results', () => {
  assert.equal(sessionScrollOffset(20, 5, 3, true), 15);
  assert.equal(sessionScrollOffset(80, 5, 3, true), 75);
  assert.equal(sessionScrollOffset(80, 5, 3, false), 3);
});

test('sanitizeCapturedDashboardWrites removes SDK transformer preamble', () => {
  const captured = [
    'before',
    '🔧 [TRANSFORMERS-ENV] Environment configured globally: {',
    '  allowLocalModels: true,',
    '  allowRemoteModels: false,',
    '}',
    'after',
  ].join('\n');

  assert.equal(sanitizeCapturedDashboardWrites(captured), 'before\nafter');
});

test('wrapSessionLine wraps long content instead of truncating with ellipsis', () => {
  const wrapped = wrapSessionLine('    "content": "Same shape, same red glow, same arrow Tagline: 12 LISTED"', 36);

  assert.deepEqual(wrapped, [
    '    "content": "Same shape, same red',
    '    glow, same arrow Tagline: 12',
    '    LISTED"',
  ]);
  assert.equal(wrapped.some((line) => line.includes('...')), false);
});

test('wrapSessionLine hard-wraps long unbroken continuations after indentation', () => {
  const wrapped = wrapSessionLine(
    'ok   sdk.resolution  file:/Users/philippemortelette/Documents/AtomicMemory/atomicmemory/atomicmemory-sdk',
    20,
  );

  assert.ok(wrapped.length > 2);
  assert.ok(wrapped.every((line) => line.length <= 20));
  assert.match(wrapped.join(''), /cmemory-sdk$/);
});

test('wrapSessionLine caps continuation indentation to guarantee progress', () => {
  const wrapped = wrapSessionLine(`${' '.repeat(30)}long-token-without-spaces`, 10);

  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((line) => line.length <= 10));
});

test('formatDashboardCommandResult explains empty add result', () => {
  const rendered = formatDashboardCommandResult({
    command: 'add',
    data: { created: [], updated: [], unchanged: [] },
  });

  assert.match(rendered, /No memory stored/);
  assert.match(rendered, /did not create or update/);
  assert.doesNotMatch(rendered, /"created"/);
});

test('formatDashboardCommandResult summarizes stored memory ids', () => {
  const rendered = formatDashboardCommandResult({
    command: 'add',
    data: { created: ['mem-1'], updated: ['mem-2'], unchanged: [] },
  });

  assert.match(rendered, /Stored 2 memories/);
  assert.match(rendered, /created: mem-1/);
  assert.match(rendered, /updated: mem-2/);
});

test('formatDashboardCommandResult styles empty config show output', () => {
  const rendered = formatDashboardCommandResult({
    command: 'config show',
    count: 0,
    data: {
      schema_version: '2',
      activeProfile: 'default',
      profiles: {},
    },
  });

  assert.match(rendered, /config/);
  assert.match(rendered, /schema version\s+2/);
  assert.match(rendered, /active profile\s+default/);
  assert.match(rendered, /profiles\s+none/);
  assert.doesNotMatch(rendered, /"profiles"/);
});

test('formatDashboardCommandResult styles config profiles without leaking api keys', () => {
  const rendered = formatDashboardCommandResult({
    command: 'config show',
    count: 2,
    data: {
      schema_version: '2',
      activeProfile: 'local',
      profiles: {
        cloud: {
          provider: 'atomicmemory',
          apiUrl: 'https://api.atomicmemory.dev',
          trustSurface: 'authenticated-wrapper',
          output: 'json',
          apiKey: '***',
        },
        local: {
          provider: 'atomicmemory',
          apiUrl: 'http://localhost:3050',
          trustSurface: 'local',
          scope: {
            user: 'user-1',
            namespace: 'testing',
          },
          apiKey: 'super-secret',
        },
      },
    },
  });

  assert.match(rendered, /profile local \(active\)/);
  assert.match(rendered, /provider\s+atomicmemory/);
  assert.match(rendered, /trust surface\s+local/);
  assert.match(rendered, /api url\s+http:\/\/localhost:3050/);
  assert.match(rendered, /scope\s+user=user-1 namespace=testing/);
  assert.match(rendered, /api key\s+configured \(redacted\)/);
  assert.match(rendered, /profile cloud/);
  assert.doesNotMatch(rendered, /super-secret/);
  assert.doesNotMatch(rendered, /"apiKey"/);
});

test('formatDashboardCommandResult summarizes doctor output for interactive mode', () => {
  const rendered = formatDashboardCommandResult({
    command: 'doctor',
    data: {
      ok: false,
      mode: 'full',
      fix: false,
      fixedAny: false,
      checks: [
        {
          id: 'env.node_version',
          category: 'env',
          ok: true,
          detail: 'node=24.0.0',
        },
        {
          id: 'active_profile.present',
          category: 'active_profile',
          ok: false,
          detail: 'no profiles; run `atomicmemory init`',
        },
        {
          id: 'sdk.resolution',
          category: 'sdk_resolution',
          ok: true,
          detail: 'file:/Users/philippemortelette/Documents/AtomicMemory/atomicmemory/atomicmemory-sdk (built)',
        },
      ],
    },
  });

  assert.match(rendered, /doctor needs attention/);
  assert.match(rendered, /mode full  checks 2 ok \/ 1 fail/);
  assert.match(rendered, /needs attention\n✗\s+active_profile\.present\s+no profiles/);
  assert.match(rendered, /passed\n✓\s+env\.node_version\s+node=24\.0\.0/);
  assert.match(rendered, /✓\s+sdk\.resolution\s+local SDK built/);
  assert.doesNotMatch(rendered, /"checks"/);
  assert.doesNotMatch(rendered, /\/Users\/philippemortelette/);
});

function dashboardRuntimeState(): RuntimeState {
  return {
    mode: 'text',
    profileName: 'default',
    scope: { user: 'user-1' },
    config: {
      schema_version: '2',
      activeProfile: 'default',
      profiles: {},
    },
    profile: null,
    paths: { dir: '', file: '' },
  };
}

function sessionState(file: string, dir: string, fallbackUser?: string): RuntimeState {
  const config = JSON.parse(readFileSync(file, 'utf8')) as RuntimeState['config'];
  const profile = config.profiles[config.activeProfile] ?? null;
  return {
    mode: 'text',
    profileName: config.activeProfile,
    scope: profile?.scope ?? (fallbackUser ? { user: fallbackUser } : {}),
    config,
    profile,
    paths: { dir, file },
  };
}

function sessionConfig(user: string): RuntimeState['config'] {
  return {
    schema_version: '2',
    activeProfile: 'default',
    profiles: {
      default: {
        provider: 'atomicmemory',
        apiUrl: 'http://localhost:3050',
        trustSurface: 'local',
        scope: { user },
      },
    },
  };
}

function statusCapabilities() {
  return {
    ingestModes: ['text'],
    extensions: { package: true },
  };
}

function statusAdapter() {
  return {
    providerName: 'atomicmemory' as const,
    initialize: async () => undefined,
    getStatus: async () => ({ ok: true, provider: 'atomicmemory' as const }),
    getCapabilities: async () => statusCapabilities(),
    addMemory: async () => ({ created: [], updated: [], unchanged: [] }),
    ingestMemories: async () => ({ created: [], updated: [], unchanged: [] }),
    searchMemories: async () => [],
    listMemories: async () => ({ memories: [] }),
    getMemory: async () => null,
    deleteMemory: async () => undefined,
    packageContext: async () => ({ text: '', tokens: 0, hits: [], budgetConstrained: false }),
  };
}
