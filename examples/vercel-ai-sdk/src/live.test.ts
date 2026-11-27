/** Check that the local live example refuses Cloud and legacy backend configuration. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function assertBackendRejected(backend: NodeJS.ProcessEnv): void {
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./live.ts', import.meta.url)), 'save'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ATOMICMEMORY_API_URL: 'http://127.0.0.1:17350',
      ATOMICMEMORY_ALLOW_PRIVATE_NETWORKS: 'true',
      ATOMICMEMORY_API_KEY: 'fixture-old-core-token',
      ATOMICMEMORY_USER_ID: 'fixture-user',
      OPENAI_API_KEY: 'fixture-openai-key',
      OPENAI_MODEL: 'fixture-model',
      ...backend,
    },
    timeout: 5000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /This example requires ATOMICMEMORY_BACKEND=local/);
  assert.doesNotMatch(child.stderr, /fixture-old-core-token|fixture-openai-key/);
}

test('live example rejects legacy local setup without an explicit backend', () => {
  assertBackendRejected({});
});

test('live example does not run against Hosted Cloud', () => {
  assertBackendRejected({
    ATOMICMEMORY_BACKEND: 'cloud',
    CORE_API_URL: 'http://127.0.0.1:17350',
    CORE_API_KEY: 'fixture-old-core-token',
  });
});
