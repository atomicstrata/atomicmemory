/** Exercise deployment failure paths without contacting AWS. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function roll(t, failAt) {
  const dir = mkdtempSync(join(tmpdir(), 'am-ecs-order-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'aws'), `#!/usr/bin/env node
const fs = require('node:fs');
const operation = process.argv.slice(2, 4).join(' ');
fs.appendFileSync(process.env.AM_TEST_LOG, operation + '\\n');
if (operation === process.env.AM_TEST_FAIL) process.exit(1);
if (operation === 'ecs describe-services') console.log('old-task');
if (operation === 'ecs describe-task-definition') {
  console.log(JSON.stringify({family:'test',containerDefinitions:[{name:'core',image:'example/core:old'}]}));
}
if (operation === 'ecs register-task-definition') console.log('new-task');
`, { mode: 0o755 });
  const result = spawnSync('bash', [
    'scripts/ci/roll-core-ecs-image.sh', 'example/core:new', 'example/core',
    '/test/image', 'test-cluster', 'test-service',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AM_TEST_LOG: log, AM_TEST_FAIL: failAt },
  });
  return { result, calls: readFileSync(log, 'utf8').trim().split('\n') };
}

for (const operation of ['ecs describe-services', 'ecs register-task-definition', 'ecs update-service']) {
  test(`does not advance SSM when ${operation} fails`, (t) => {
    const { result, calls } = roll(t, operation);
    assert.notEqual(result.status, 0);
    assert.ok(!calls.includes('ssm put-parameter'));
  });
}

test('records SSM only after ECS accepts the new task definition', (t) => {
  const { result, calls } = roll(t, '');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    'ecs describe-services', 'ecs describe-task-definition',
    'ecs register-task-definition', 'ecs update-service', 'ssm put-parameter',
  ]);
});
