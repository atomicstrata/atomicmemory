/**
 * @file Profile load/save/list/use/show/add/redact/overlay tests.
 *
 * The `--force` protection is exercised against EVERY populated field
 * (not just apiKey/scope.*), since silently clobbering a configured
 * profile via a re-run of `init` would break the v5 contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REDACTED_API_KEY,
  addProfile,
  getActiveProfile,
  listProfileNames,
  loadConfig,
  mergeNonInitOverlay,
  redactProfile,
  saveConfig,
  setActiveProfile,
  showProfile,
} from '../config/profiles.js';
import { emptyConfig, type CliProfileShape } from '../config/schema.js';
import { CliError } from '../types.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'atomicmem-profiles-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseProfile: CliProfileShape = {
  provider: 'atomicmemory',
  apiUrl: 'http://localhost:3000',
  trustSurface: 'local',
};

test('loadConfig returns an empty bootstrap config when the file is missing', () => {
  withTempDir((dir) => {
    const file = join(dir, 'config.json');
    const cfg = loadConfig(file);
    assert.equal(cfg.schema_version, '2');
    assert.equal(cfg.activeProfile, 'default');
    assert.deepEqual(cfg.profiles, {});
  });
});

test('saveConfig writes a 0600 file inside a 0700 dir, then loadConfig roundtrips', () => {
  withTempDir((root) => {
    const dir = join(root, 'sub');
    const file = join(dir, 'config.json');
    const cfg = addProfile(emptyConfig(), 'default', baseProfile);
    saveConfig(file, dir, cfg);

    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const loaded = loadConfig(file);
    assert.deepEqual(loaded, cfg);
  });
});

test('saveConfig refuses to persist a malformed config (defense in depth)', () => {
  withTempDir((root) => {
    const dir = join(root, 'sub');
    const file = join(dir, 'config.json');
    const bogus = {
      schema_version: '1', // wrong literal
      activeProfile: 'default',
      profiles: {},
    } as unknown as ReturnType<typeof emptyConfig>;
    assert.throws(() => saveConfig(file, dir, bogus));
    assert.equal(existsSync(file), false);
  });
});

test('loadConfig surfaces zod errors as CliError(usage) on tampered files', () => {
  withTempDir((dir) => {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"schema_version":"x"}');
    assert.throws(
      () => loadConfig(file),
      (e: unknown) =>
        e instanceof CliError && e.code === 'usage' && e.exitCode === 2,
    );
  });
});

test('addProfile bootstraps "default" into an empty config', () => {
  const cfg = addProfile(emptyConfig(), 'default', baseProfile);
  assert.deepEqual(listProfileNames(cfg), ['default']);
  assert.equal(getActiveProfile(cfg)?.apiUrl, 'http://localhost:3000');
});

test('addProfile without --force rejects ANY populated field, not only apiKey/scope', () => {
  // A profile with only the required required-by-schema fields is still
  // populated (provider/apiUrl/trustSurface are set) — re-adding without
  // --force must not silently overwrite it.
  const cfg = addProfile(emptyConfig(), 'default', baseProfile);
  assert.throws(
    () =>
      addProfile(cfg, 'default', { ...baseProfile, apiUrl: 'http://other' }),
    (e: unknown) => e instanceof CliError && e.code === 'usage',
  );

  // Same protection for an output-only customization.
  const withOutput = addProfile(emptyConfig(), 'p1', {
    ...baseProfile,
    output: 'agent',
  });
  assert.throws(
    () => addProfile(withOutput, 'p1', baseProfile),
    (e: unknown) => e instanceof CliError && e.code === 'usage',
  );

  // And for an apiKey-only customization.
  const withKey = addProfile(emptyConfig(), 'p2', {
    ...baseProfile,
    apiKey: 'sk-x',
  });
  assert.throws(
    () => addProfile(withKey, 'p2', baseProfile),
    (e: unknown) => e instanceof CliError && e.code === 'usage',
  );

  // And for a scope.* customization.
  const withScope = addProfile(emptyConfig(), 'p3', {
    ...baseProfile,
    scope: { user: 'u1' },
  });
  assert.throws(
    () => addProfile(withScope, 'p3', baseProfile),
    (e: unknown) => e instanceof CliError && e.code === 'usage',
  );
});

test('addProfile with --force overwrites any populated profile', () => {
  const cfg = addProfile(emptyConfig(), 'default', {
    ...baseProfile,
    apiKey: 'sk-old',
    scope: { user: 'u-old' },
    output: 'agent',
  });
  const next = addProfile(
    cfg,
    'default',
    { ...baseProfile, apiUrl: 'http://new', output: 'json' },
    { force: true },
  );
  assert.equal(next.profiles.default?.apiUrl, 'http://new');
  assert.equal(next.profiles.default?.output, 'json');
  assert.equal(next.profiles.default?.apiKey, undefined);
  assert.equal(next.profiles.default?.scope, undefined);
});

test('setActiveProfile points at an existing profile and rejects unknown names with not_found', () => {
  let cfg = addProfile(emptyConfig(), 'default', baseProfile);
  cfg = addProfile(cfg, 'cloud', { ...baseProfile, trustSurface: 'self-hosted', apiUrl: 'http://cloud' });
  cfg = setActiveProfile(cfg, 'cloud');
  assert.equal(cfg.activeProfile, 'cloud');
  assert.throws(
    () => setActiveProfile(cfg, 'mystery'),
    (e: unknown) =>
      e instanceof CliError && e.code === 'not_found' && e.exitCode === 4,
  );
});

test('showProfile returns the profile with apiKey redacted; rejects unknown names', () => {
  const cfg = addProfile(emptyConfig(), 'default', {
    ...baseProfile,
    apiKey: 'sk-secret',
  });
  const shown = showProfile(cfg, 'default');
  assert.equal(shown.apiKey, REDACTED_API_KEY);
  assert.throws(
    () => showProfile(cfg, 'mystery'),
    (e: unknown) => e instanceof CliError && e.code === 'not_found',
  );
});

test('redactProfile does not produce ***  when no apiKey is set', () => {
  const out = redactProfile(baseProfile);
  assert.equal(out.apiKey, undefined);
});

test('mergeNonInitOverlay produces a transient view without touching disk', () => {
  const profile: CliProfileShape = {
    ...baseProfile,
    scope: { user: 'persisted' },
  };
  const merged = mergeNonInitOverlay(profile, {
    provider: 'mem0',
    apiUrl: 'http://override',
    output: 'agent',
    scope: { agent_id: 'a1', namespace: 'n1' },
  });
  // --provider is now a supported overlay field so flags > env > config
  // applies on the global provider switch as well.
  assert.equal(merged.provider, 'mem0');
  assert.equal(merged.apiUrl, 'http://override');
  assert.equal(merged.output, 'agent');
  // user from profile + agent_id/namespace from overlay
  assert.deepEqual(merged.scope, {
    user: 'persisted',
    agent_id: 'a1',
    namespace: 'n1',
  });
  // original profile is unchanged
  assert.equal(profile.provider, 'atomicmemory');
  assert.deepEqual(profile.scope, { user: 'persisted' });
});

test('mergeNonInitOverlay: omitting provider leaves the persisted provider intact', () => {
  const profile: CliProfileShape = { ...baseProfile, provider: 'atomicmemory' };
  const merged = mergeNonInitOverlay(profile, { apiUrl: 'http://elsewhere' });
  assert.equal(merged.provider, 'atomicmemory');
  assert.equal(merged.apiUrl, 'http://elsewhere');
});
