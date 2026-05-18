/**
 * @file Commander bridge tests — covers hidden visibility (the V0 mistake
 * that motivated this Phase 2 fix), top-level option registration, child
 * command nesting, and flag-declaration parsing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgram,
  isNegationFlag,
  parseFlagDecl,
} from '../spec/commander-bridge.js';
import { _resetSpecCache, loadSpec } from '../spec/loader.js';

function freshProgram() {
  _resetSpecCache();
  return buildProgram(loadSpec());
}

test('buildProgram registers every spec command (visible and hidden)', () => {
  const program = freshProgram();
  const programNames = new Set(program.commands.map((c) => c.name()));
  for (const expected of [
    'init',
    'doctor',
    'status',
    'hooks',
    'search',
    'package',
    'lifecycle',
    'audit',
    'lessons',
    'agents',
  ]) {
    assert.ok(programNames.has(expected), `expected commander to register "${expected}"`);
  }
});

test('hidden experimental commands are registered for dispatch but absent from default help', () => {
  const program = freshProgram();
  const help = program.helpInformation();
  for (const hiddenName of ['lifecycle', 'audit', 'lessons', 'agents']) {
    const cmd = program.commands.find((c) => c.name() === hiddenName);
    assert.ok(cmd, `${hiddenName} must still be registered`);
    // Commander's _hidden flag must be set so default help omits it.
    assert.equal(
      (cmd as unknown as { _hidden?: boolean })._hidden,
      true,
      `${hiddenName} must have commander _hidden=true`,
    );
    const tokenPattern = new RegExp(`(^|\\s)${hiddenName}\\b`);
    assert.equal(
      tokenPattern.test(help),
      false,
      `default help must NOT mention hidden command "${hiddenName}"`,
    );
  }
});

test('visible commands DO appear in default help', () => {
  const program = freshProgram();
  const help = program.helpInformation();
  for (const visibleName of ['init', 'doctor', 'status', 'hooks', 'search', 'package']) {
    assert.ok(
      help.includes(visibleName),
      `default help should mention visible command "${visibleName}"`,
    );
  }
});

test('every spec global option (including --no-* negations) is registered', () => {
  _resetSpecCache();
  const spec = loadSpec();
  const program = buildProgram(spec);
  const programLongs = new Set(program.options.map((o) => o.long));
  for (const opt of spec.global_options) {
    const flagName = opt.name.split(/\s+/)[0]!;
    assert.ok(
      programLongs.has(flagName),
      `expected commander to register top-level option "${flagName}"`,
    );
  }
});

test('--interactive and --no-interactive both toggle the underlying boolean', () => {
  _resetSpecCache();
  const spec = loadSpec();

  const positive = buildProgram(spec);
  positive.exitOverride();
  positive.action(() => {});
  positive.parse(['node', 'cli', '--interactive'], { from: 'node' });
  assert.equal((positive.opts() as { interactive?: boolean }).interactive, true);

  const negation = buildProgram(spec);
  negation.exitOverride();
  negation.action(() => {});
  negation.parse(['node', 'cli', '--no-interactive'], { from: 'node' });
  assert.equal((negation.opts() as { interactive?: boolean }).interactive, false);
});

test('config has profile child registered as nested commander subcommand', () => {
  const program = freshProgram();
  const config = program.commands.find((c) => c.name() === 'config');
  assert.ok(config);
  const profile = config?.commands.find((c) => c.name() === 'profile');
  assert.ok(profile, 'config profile should exist as nested subcommand');
  const list = profile?.commands.find((c) => c.name() === 'list');
  assert.ok(list, 'config profile list should exist');
});

test('isNegationFlag identifies --no-* declarations only', () => {
  assert.equal(isNegationFlag('--no-interactive'), true);
  assert.equal(isNegationFlag('  --no-color  '), true);
  assert.equal(isNegationFlag('--interactive'), false);
  assert.equal(isNegationFlag('--node-version'), false);
  assert.equal(isNegationFlag('--filter-json JSON'), false);
});

test('parseFlagDecl turns spec flag strings into commander option declarations', () => {
  assert.equal(parseFlagDecl('--api-key-stdin').commanderForm, '--api-key-stdin');
  assert.equal(parseFlagDecl('--limit N').commanderForm, '--limit <n>');
  assert.equal(parseFlagDecl('--filter-json JSON').commanderForm, '--filter-json <json>');
  assert.equal(parseFlagDecl('--mode text|messages|verbatim').commanderForm, '--mode <mode>');
  assert.equal(parseFlagDecl('--file PATH|-').commanderForm, '--file <path>');
  // The placeholder description preserves enum choices for help text.
  assert.equal(
    parseFlagDecl('--mode text|messages|verbatim').placeholderDescription,
    'one of: text|messages|verbatim',
  );
});
