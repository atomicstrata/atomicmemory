/** Exercise the production sync against real local Git remotes. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../sync-public-to-private.sh', import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_TERMINAL_PROMPT: '0' };
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(dir, file, value) {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), value);
  git(dir, 'add', file);
  git(dir, 'commit', '-m', `Update ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'am-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const remote = join(root, 'private.git');
  const runner = join(root, 'runner');
  git(root, 'init', '-b', 'main', source);
  commit(source, 'shared.txt', 'baseline\n');
  commit(source, '.gitattributes', 'packages/core/hosted export-ignore\n');
  git(root, 'clone', '--bare', source, remote);
  git(root, 'clone', source, runner);
  git(runner, 'remote', 'add', 'private-target', remote);
  commit(source, 'packages/core/hosted/overlay.mjs', 'private fixture\n');
  git(source, 'push', remote, 'HEAD:main');
  return { root, source, remote, runner };
}
function sync(f) {
  return spawnSync('bash', [script, 'private-target', git(f.runner, 'rev-parse', 'HEAD')], { cwd: f.runner, env, encoding: 'utf8' });
}

test('merges public updates and keeps private files/history out of the export', (t) => {
  const f = fixture(t);
  commit(f.source, 'internal.txt', 'new private work\n');
  git(f.source, 'push', f.remote, 'HEAD:main');
  const previous = git(f.source, 'rev-parse', 'HEAD');
  const published = commit(f.runner, 'shared.txt', 'public update\n');
  const result = sync(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', 'main:packages/core/hosted/overlay.mjs'), 'private fixture');
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', 'main:shared.txt'), 'public update');
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', 'main:internal.txt'), 'new private work');
  git(f.runner, 'merge-base', '--is-ancestor', previous, 'HEAD');
  git(f.runner, 'merge-base', '--is-ancestor', published, 'HEAD');
  const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: f.runner });
  const paths = spawnSync('tar', ['-tf', '-'], { input: archive.stdout, encoding: 'utf8' });
  assert.equal(archive.status, 0);
  assert.equal(paths.status, 0);
  assert.match(paths.stdout, /shared.txt/);
  assert.doesNotMatch(paths.stdout, /packages\/core\/hosted/);
  assert.equal(sync(f).status, 0, 'rerun is idempotent');
});

test('conflicting shared edits leave private main untouched', (t) => {
  const f = fixture(t);
  const before = commit(f.source, 'shared.txt', 'private edit\n');
  git(f.source, 'push', f.remote, 'HEAD:main');
  commit(f.runner, 'shared.txt', 'public edit\n');
  const result = sync(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /merge conflicted/);
  assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'main'), before);
  assert.equal(git(f.runner, 'status', '--porcelain'), '');
});

test('a concurrent private push is rejected rather than overwritten', (t) => {
  const f = fixture(t);
  const newer = commit(f.source, 'concurrent.txt', 'must survive\n');
  git(f.source, 'push', f.remote, 'HEAD:refs/heads/race');
  commit(f.runner, 'public.txt', 'public change\n');
  const hook = join(f.runner, '.git/hooks/pre-push');
  writeFileSync(hook, `#!/bin/sh\ngit --git-dir='${f.remote}' update-ref refs/heads/main ${newer}\n`, { mode: 0o755 });
  const result = sync(f);
  assert.notEqual(result.status, 0);
  assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'main'), newer);
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', 'main:concurrent.txt'), 'must survive');
});

test('workflow calls the tested merge path, never a force-push', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/sync-to-private.yml', import.meta.url), 'utf8');
  assert.match(workflow, /bash scripts\/ci\/sync-public-to-private\.sh private-target "\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow, /--force/);
});
