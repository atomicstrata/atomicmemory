/**
 * @file Completion-script generator tests. The key invariants are:
 *
 *   - hidden experimental commands MUST NOT appear in generated
 *     completions (per v5 §"Two key user decisions locked")
 *   - multi-word child names ("profile list", "profile use",
 *     "profile show") must be reassembled into a nested tree so
 *     `atomicmemory config` suggests {show, get, set, unset, profile}
 *     and `atomicmemory config profile` suggests {list, use, show}.
 *     The earlier flattened behavior incorrectly leaked list/use/show
 *     into the first level.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompletionTree,
  generateCompletion,
} from '../spec/completions.js';
import { _resetSpecCache, loadSpec } from '../spec/loader.js';

function spec() {
  _resetSpecCache();
  return loadSpec();
}

test('buildCompletionTree models config -> profile -> list/use/show as nested children', () => {
  const tree = buildCompletionTree(spec());
  const config = tree.children.get('config');
  assert.ok(config, 'config must be a top-level child');
  // config's direct children should be the four leaf actions plus the
  // "profile" prefix; NOT the flattened list/use/show.
  const direct = Array.from(config!.children.keys()).sort();
  assert.deepEqual(direct, ['get', 'profile', 'set', 'show', 'unset']);
  for (const leaked of ['list', 'use']) {
    assert.equal(
      config!.children.has(leaked),
      false,
      `"${leaked}" must not appear as a direct child of "config" (it belongs under profile)`,
    );
  }
  const profile = config!.children.get('profile');
  assert.ok(profile, 'config.profile must be a nested child');
  assert.deepEqual(
    Array.from(profile!.children.keys()).sort(),
    ['list', 'show', 'use'],
  );
});

test('buildCompletionTree skips hidden top-level commands entirely', () => {
  const tree = buildCompletionTree(spec());
  for (const hidden of ['lifecycle', 'audit', 'lessons', 'agents']) {
    assert.equal(
      tree.children.has(hidden),
      false,
      `hidden command "${hidden}" must not appear in the completion tree`,
    );
  }
});

test('bash completion lists every visible top-level command', () => {
  const out = generateCompletion('bash', spec());
  for (const visible of ['init', 'doctor', 'status', 'search', 'package', 'list', 'get']) {
    assert.ok(
      out.includes(visible),
      `bash completion should list visible command "${visible}"`,
    );
  }
});

test('bash completion: after `config`, suggests the four direct actions plus the profile prefix only', () => {
  const out = generateCompletion('bash', spec());
  // Locate the config arm.
  const configArm = out.match(/config\)\s*\n([\s\S]*?)\n\s*;;/);
  assert.ok(configArm, 'bash output must contain a config) case arm');
  const armBody = configArm![1]!;
  // Extract the second-token compgen list (the COMPREPLY assigned when
  // CURRENT == 2 inside the config arm).
  const directListMatch = armBody.match(/compgen -W "([^"]+)" -- "\$cur"/);
  assert.ok(directListMatch, 'config arm must offer a compgen suggestion list');
  const directNames = directListMatch![1]!.split(/\s+/).sort();
  assert.deepEqual(directNames, ['get', 'profile', 'set', 'show', 'unset']);
});

test('bash completion: after `config profile`, suggests list/use/show only', () => {
  const out = generateCompletion('bash', spec());
  // The config arm contains a nested case for cmd2 that includes a
  // `profile)` arm with its own compgen list.
  const profileArm = out.match(/profile\)\s*\n\s*COMPREPLY=\(\s*\$\(compgen -W "([^"]+)"/);
  assert.ok(profileArm, 'bash output must contain a config -> profile nested arm');
  const grandNames = profileArm![1]!.split(/\s+/).sort();
  assert.deepEqual(grandNames, ['list', 'show', 'use']);
});

test('bash completion does NOT list hidden experimental commands at any level', () => {
  const out = generateCompletion('bash', spec());
  for (const hidden of ['lifecycle', 'audit', 'lessons', 'agents']) {
    const tokenPattern = new RegExp(`["\\s]${hidden}["\\s]`);
    assert.equal(
      tokenPattern.test(out),
      false,
      `bash completion must omit hidden command "${hidden}"`,
    );
  }
});

test('zsh completion lists every visible top-level command with summary', () => {
  const out = generateCompletion('zsh', spec());
  for (const visible of ['init', 'doctor', 'status', 'search', 'package']) {
    assert.ok(out.includes(`'${visible}:`), `zsh completion should list "${visible}"`);
  }
});

test('zsh completion: after `config`, _values offers direct children plus profile prefix only', () => {
  const out = generateCompletion('zsh', spec());
  const configArm = out.match(/config\)\s*\n([\s\S]*?);;/);
  assert.ok(configArm, 'zsh output must contain a config) case arm');
  const armBody = configArm![1]!;
  // The CURRENT==3 branch lists direct children; assert it does NOT
  // contain "list" or "use" (those belong under config profile).
  const directLine = armBody.match(/_values 'subcommand' ([^\n]+)/);
  assert.ok(directLine, 'config arm should offer a _values list at the second-token level');
  const args = directLine![1]!;
  for (const expected of ['show', 'get', 'set', 'unset', 'profile']) {
    assert.ok(args.includes(`'${expected}'`), `expected '${expected}' in config _values list`);
  }
  // The leaked grandchildren must be absent at this level.
  for (const leaked of ['list', 'use']) {
    assert.equal(
      args.includes(`'${leaked}'`),
      false,
      `'${leaked}' must not appear at the config first-level _values`,
    );
  }
});

test('zsh completion: after `config profile`, _values offers list/use/show only', () => {
  const out = generateCompletion('zsh', spec());
  // Locate the nested profile arm.
  const nested = out.match(/profile\)\s*\n\s*_values 'subcommand' ([^\n]+)/);
  assert.ok(nested, 'zsh output must contain a config -> profile nested arm');
  const args = nested![1]!;
  for (const expected of ['list', 'use', 'show']) {
    assert.ok(args.includes(`'${expected}'`), `expected '${expected}' under profile _values`);
  }
});

test('zsh completion does NOT list hidden experimental commands at any level', () => {
  const out = generateCompletion('zsh', spec());
  for (const hidden of ['lifecycle', 'audit', 'lessons', 'agents']) {
    assert.equal(
      out.includes(`'${hidden}:`),
      false,
      `zsh completion must omit hidden command "${hidden}"`,
    );
  }
});

test('completion includes the override binary name when provided', () => {
  const out = generateCompletion('bash', spec(), { bin: 'am' });
  assert.ok(out.includes('complete -F _am_completions am'));
});
