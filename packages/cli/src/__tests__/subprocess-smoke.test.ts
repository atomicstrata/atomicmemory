/**
 * @file Subprocess smoke tests for the built CLI binary. Audit item 1
 * called for these explicitly: every `--json` and `--agent` invocation
 * must emit exactly one parseable JSON object on stdout with no
 * preamble (e.g. the SDK's transformers-env logger). The non-provider
 * commands tested here never trigger SDK module load thanks to the
 * lazy adapter registry, so they should be clean even when the
 * upstream SDK still logs at import time.
 *
 * Tests skip gracefully when `dist/bin.js` does not exist yet (e.g.
 * fresh checkout before `pnpm build`); CI runs `pnpm build` before
 * `pnpm test` so the dist is available there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');
const binPath = resolve(cliRoot, 'dist', 'bin.js');
const missingConfigPath = resolve(cliRoot, '.subprocess-smoke-missing-config.json');
const ATOMICMEMORY_ENV_KEYS = [
  'ATOMICMEMORY_API_KEY',
  'ATOMICMEMORY_API_URL',
  'ATOMICMEMORY_CONFIG',
  'ATOMICMEMORY_PROVIDER',
  'ATOMICMEMORY_SCOPE_AGENT_ID',
  'ATOMICMEMORY_SCOPE_NAMESPACE',
  'ATOMICMEMORY_SCOPE_THREAD',
  'ATOMICMEMORY_SCOPE_USER',
  'ATOMICMEMORY_TRUST_SURFACE',
] as const;

function isolatedSubprocessEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ATOMICMEMORY_ENV_KEYS) delete env[key];
  return {
    ...env,
    ATOMICMEMORY_CONFIG: missingConfigPath,
    ...overrides,
    NO_COLOR: '1',
  };
}

function runBin(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: isolatedSubprocessEnv(env),
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? -1,
  };
}

const skipIfUnbuilt = !existsSync(binPath);

test('subprocess: --json version emits exactly one parseable JSON object on stdout, no preamble', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--json', 'version']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `expected exactly one stdout line; got ${lines.length}: ${r.stdout}`);
  const parsed = JSON.parse(lines[0]!) as { command: string; data: { version: string } };
  assert.equal(parsed.command, 'version');
  assert.match(parsed.data.version, /^\d+\.\d+\.\d+$/);
});

test('subprocess: --agent version emits exactly one stable envelope on stdout, no preamble', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--agent', 'version']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `expected exactly one stdout line; got ${lines.length}: ${r.stdout}`);
  const env = JSON.parse(lines[0]!) as {
    status: string;
    command: string;
    profile: string;
    data: { version: string };
  };
  assert.equal(env.status, 'success');
  assert.equal(env.command, 'version');
});

test('subprocess: --json help emits exactly one parseable JSON document, no preamble', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--json', 'help']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const doc = JSON.parse(lines[0]!) as { command: string; data: { commands: unknown[] } };
  assert.equal(doc.command, 'help');
  assert.ok(Array.isArray(doc.data.commands));
});

test('subprocess: hooks install is provider-free even with partial provider env', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--json', 'hooks', 'install', '--host', 'codex'], {
    ATOMICMEMORY_PROVIDER: 'atomicmemory',
    ATOMICMEMORY_API_URL: 'https://core.example.invalid',
  });

  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim()) as {
    command: string;
    data: { runtime: string; host: string };
  };
  assert.equal(parsed.command, 'hooks');
  assert.equal(parsed.data.host, 'codex');
  assert.equal(parsed.data.runtime, 'node');
});

test('subprocess: search --threshold under --json yields exit 2 with JSON error envelope on stderr', { skip: skipIfUnbuilt }, () => {
  // Per v5 §"Output Semantics": JSON-mode errors land on stderr;
  // only --agent errors land on stdout.
  const r = runBin(['--json', 'search', '--threshold', '0.5', 'q']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  const lines = r.stderr.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `expected one error envelope on stderr; got: ${r.stderr}`);
  const env = JSON.parse(lines[0]!) as {
    status: string;
    error: { code: string; message: string };
  };
  assert.equal(env.status, 'error');
  assert.equal(env.error.code, 'usage');
  assert.match(env.error.message, /threshold|unknown/i);
});

test('subprocess: search --threshold under --agent yields exit 2 with JSON error envelope on stdout', { skip: skipIfUnbuilt }, () => {
  // Per v5 §"Output Semantics": agent-mode errors land on stdout.
  const r = runBin(['--agent', 'search', '--threshold', '0.5', 'q']);
  assert.equal(r.code, 2);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const env = JSON.parse(lines[0]!) as {
    status: string;
    error: { code: string };
  };
  assert.equal(env.status, 'error');
  assert.equal(env.error.code, 'usage');
});

test('subprocess: bare --api-key flag is rejected before any command runs (exit 2)', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--api-key', 'sk-leak', 'version']);
  assert.equal(r.code, 2);
  // Plain text path because --json was not passed; renderer wrote to
  // stderr per v5 §"Output Semantics".
  assert.match(r.stderr, /--api-key/);
  assert.equal(r.stdout, '');
});

test('subprocess: hidden experimental command requires --experimental (exit 2 experimental_disabled)', { skip: skipIfUnbuilt }, () => {
  // Use --agent so the error envelope lands on stdout (parseable here).
  const r = runBin(['--agent', 'lifecycle']);
  assert.equal(r.code, 2);
  const env = JSON.parse(r.stdout.trim()) as {
    error: { code: string; message: string };
  };
  assert.equal(env.error.code, 'experimental_disabled');
});

// ---------------------------------------------------------------------------
// Audit-3 concrete repros: positional argument capture must work end-to-end
// through commander → bindActions → registry. These tests run the real
// built binary so they regress if commander registration ever drops the
// argument metadata again.
// ---------------------------------------------------------------------------

test('subprocess: completion bash captures the shell positional and emits the bash completion script', { skip: skipIfUnbuilt }, () => {
  // completion's spec advertises only text output, so we run it
  // without --json/--agent. The text renderer emits the result data
  // (the generated script) directly.
  const r = runBin(['completion', 'bash']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  assert.match(r.stdout, /complete -F _atomicmemory_completions atomicmemory/);
  assert.ok(r.stdout.includes('bash'));
});

test('subprocess: skill get <name> dispatches to the "skill get" registry path with positional', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--agent', 'skill', 'get', 'core']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  const env = JSON.parse(r.stdout.trim()) as {
    status: string;
    command: string;
    data: { name: string; content: string };
  };
  assert.equal(env.status, 'success');
  assert.equal(env.command, 'skill get');
  assert.equal(env.data.name, 'core');
  assert.ok(env.data.content.length > 0);
});

test('subprocess: skill list dispatches to the "skill list" registry path', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--agent', 'skill', 'list']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  const env = JSON.parse(r.stdout.trim()) as {
    status: string;
    command: string;
    data: { skills: Array<{ name: string }> };
  };
  assert.equal(env.command, 'skill list');
  assert.ok(env.data.skills.length > 0);
});

test('subprocess: help <command> captures the command positional', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--json', 'help', 'search']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  // help in --json mode emits the spec document; with a positional
  // argument it produces command-specific text data, both delivered
  // through the standard envelope.
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const env = JSON.parse(lines[0]!) as { command: string };
  assert.equal(env.command, 'help');
});

test('subprocess: get <id> captures the id positional and routes to the get handler', { skip: skipIfUnbuilt }, () => {
  // We exit with a profile-required error (no profile in the test
  // env), but the parser still routes to "get" with positional ['m1']
  // — proving the positional reached at least the lifecycle layer.
  const r = runBin(['--agent', 'get', 'm1']);
  assert.equal(r.code, 2);
  const env = JSON.parse(r.stdout.trim()) as {
    status: string;
    command: string;
    error: { code: string };
  };
  assert.equal(env.status, 'error');
  assert.equal(env.command, 'get');
  // The error must be the v5 deterministic missing-user/usage failure,
  // not the handler's "missing_input: requires id" — which would mean
  // commander dropped the positional.
  assert.notEqual(env.error.code, 'missing_input');
});

test('subprocess: search <query...> --limit captures variadic query and numeric limit', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--agent', 'search', 'release', 'policy', '--limit', '5']);
  // No profile → exit 2 usage. The positional/flag normalization
  // happens before the profile gate; if commander dropped them the
  // failure would be 'missing_input' (handler-side) instead.
  assert.equal(r.code, 2);
  const env = JSON.parse(r.stdout.trim()) as {
    command: string;
    scope?: { user?: string };
    error: { code: string };
  };
  assert.equal(env.command, 'search');
  // Static-scope check fires before the handler — error must not be
  // missing_input (which would mean commander dropped the query).
  assert.notEqual(env.error.code, 'missing_input');
});

test('subprocess: package <query...> --token-budget captures variadic query and numeric budget', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--agent', 'package', 'release', 'policy', '--token-budget', '100']);
  assert.equal(r.code, 2);
  const env = JSON.parse(r.stdout.trim()) as {
    command: string;
    error: { code: string };
  };
  assert.equal(env.command, 'package');
  assert.notEqual(env.error.code, 'missing_input');
});

test('subprocess: parseInvocation directly captures search positional + limit', async () => {
  const { parseInvocation } = await import('../cli/parse-invocation.js');
  const r = await parseInvocation(['search', 'q', '--limit', '5']);
  assert.equal(r.error, null);
  assert.ok(r.invocation);
  assert.equal(r.invocation?.path, 'search');
  assert.deepEqual(r.invocation?.positional, ['q']);
  assert.equal(r.invocation?.flags.limit, 5);
});

test('subprocess: parseInvocation captures multi-word query as variadic', async () => {
  const { parseInvocation } = await import('../cli/parse-invocation.js');
  const r = await parseInvocation(['search', 'release', 'policy', '--limit', '10']);
  assert.equal(r.error, null);
  assert.deepEqual(r.invocation?.positional, ['release', 'policy']);
  assert.equal(r.invocation?.flags.limit, 10);
});

test('subprocess: parseInvocation captures completion shell positional', async () => {
  const { parseInvocation } = await import('../cli/parse-invocation.js');
  const r = await parseInvocation(['completion', 'bash']);
  assert.equal(r.error, null);
  assert.equal(r.invocation?.path, 'completion');
  assert.deepEqual(r.invocation?.positional, ['bash']);
});

test('subprocess: parseInvocation captures hooks install runtime and host flags', async () => {
  const { parseInvocation } = await import('../cli/parse-invocation.js');
  const r = await parseInvocation(['hooks', 'install', '--runtime', 'python', '--host', 'codex']);
  assert.equal(r.error, null);
  assert.equal(r.invocation?.path, 'hooks');
  assert.deepEqual(r.invocation?.positional, ['install']);
  assert.equal(r.invocation?.flags.runtime, 'python');
  assert.equal(r.invocation?.flags.host, 'codex');
});

test('subprocess: parseInvocation captures skill get child path with positional name', async () => {
  const { parseInvocation } = await import('../cli/parse-invocation.js');
  const r = await parseInvocation(['skill', 'get', 'core']);
  assert.equal(r.error, null);
  assert.equal(r.invocation?.path, 'skill get');
  assert.deepEqual(r.invocation?.positional, ['core']);
});

test('subprocess: parseInvocation rejects extra positionals as usage error', async () => {
  const { parseInvocation } = await import('../cli/parse-invocation.js');
  // `version` takes no args; an extra positional must trip
  // allowExcessArguments(false).
  const r = await parseInvocation(['version', 'extra']);
  assert.equal(r.invocation, null);
  assert.ok(r.error);
  assert.equal(r.error?.code, 'usage');
});

// ---------------------------------------------------------------------------
// Phase 7: confirm Ink does NOT mount in non-TTY pipes. spawnSync's
// piped stdio means stdout is not a TTY; the runtime's isInteractive
// check must return false and the plain text renderer must take over.
// Ink-specific output (alt-screen escapes, cursor moves) MUST NOT
// appear in stdout. This is what every CI / agent invocation
// experiences.
// ---------------------------------------------------------------------------

test('subprocess: text-mode commands run via plain renderer (no Ink alt-screen / cursor escapes) when stdout is a pipe', { skip: skipIfUnbuilt }, () => {
  // version is text-default, so this exercises the text-mode path.
  // Ink's typical mount writes alternate-screen and cursor-control
  // escape sequences (ESC[?1049h, ESC[?25l, ESC[2J etc.) — assert
  // none appear in the captured stdout.
  const r = runBin(['version']);
  assert.equal(r.code, 0, `unexpected exit ${r.code}; stderr=${r.stderr}`);
  for (const inkEscape of [
    '\x1b[?1049h',
    '\x1b[?1049l',
    '\x1b[?25l',
    '\x1b[?25h',
    '\x1b[2J',
  ]) {
    assert.equal(
      r.stdout.includes(inkEscape),
      false,
      `Ink alt-screen / cursor escape leaked into non-TTY stdout: ${JSON.stringify(inkEscape)}`,
    );
  }
});

test('subprocess: --no-interactive plus text mode keeps the plain renderer (no Ink escapes)', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--no-interactive', 'version']);
  assert.equal(r.code, 0);
  for (const inkEscape of [
    '\x1b[?1049h',
    '\x1b[?25l',
  ]) {
    assert.equal(r.stdout.includes(inkEscape), false);
  }
});

// ---------------------------------------------------------------------------
// Generated hook commands (text mode default) must produce zero stdout on
// skips so Claude Code / Codex transcripts never see an empty turn. Machine
// modes (--json) still surface meta.reason so operators can inspect skips.
// ---------------------------------------------------------------------------

test('subprocess: hooks run user-prompt-submit skips silently in default text mode', { skip: skipIfUnbuilt }, () => {
  const r = spawnSync(process.execPath, [binPath, 'hooks', 'run', 'user-prompt-submit', '--host', 'codex'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    input: '{}',
  });
  assert.equal(r.status, 0, `unexpected exit ${r.status}; stderr=${r.stderr ?? ''}`);
  assert.equal(r.stdout ?? '', '', `expected empty stdout; got: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.stderr ?? '', '', `expected empty stderr; got: ${JSON.stringify(r.stderr)}`);
});

test('subprocess: hooks run user-prompt-submit --json still exposes meta.reason on skip', { skip: skipIfUnbuilt }, () => {
  const r = spawnSync(process.execPath, [binPath, '--json', 'hooks', 'run', 'user-prompt-submit', '--host', 'codex'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    input: '{}',
  });
  assert.equal(r.status, 0, `unexpected exit ${r.status}; stderr=${r.stderr ?? ''}`);
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `expected one envelope on stdout; got: ${r.stdout}`);
  const env = JSON.parse(lines[0]!) as { command: string; meta?: { reason?: string; skipped?: boolean } };
  assert.equal(env.command, 'hooks');
  assert.equal(env.meta?.skipped, true);
  assert.equal(env.meta?.reason, 'no_content');
});
