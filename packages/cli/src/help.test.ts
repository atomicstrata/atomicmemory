import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandSpecDocument, commandTree, renderHelp } from './help.js';

test('renderHelp includes Honcho-style sections and SDK command groups', () => {
  const help = renderHelp(undefined, '0.1.0');

  assert.match(help, /getting started/);
  assert.match(help, /atomicmemory/);
  assert.match(help, /CLI v0\.1\.0/);
  assert.match(help, /atomicmemory doctor/);
  assert.match(help, /setup\s+init .* config .* hooks .* completion/);
  assert.match(help, /memory\s+add .* search .* package/);
  assert.match(help, /agent\s+skill .* help .* version/);
});

test('commandTree exposes v5 command surfaces from cli-spec', () => {
  const names = commandTree().map((command) => command.name);

  assert.ok(names.includes('skill'));
  assert.ok(names.includes('hooks'));
  assert.ok(names.includes('validate'));
  assert.ok(names.includes('search'));
  assert.ok(names.includes('package'));
  // V0 ui and memory aliases are dropped in v5; experimental commands are
  // hidden and so are also absent from the public command tree.
  assert.ok(!names.includes('ui'));
  assert.ok(!names.includes('memory'));
  assert.ok(!names.includes('lifecycle'));
  assert.ok(!names.includes('audit'));
  assert.ok(!names.includes('lessons'));
  assert.ok(!names.includes('agents'));
});

test('commandSpecDocument exposes versioned machine-readable help', () => {
  const spec = commandSpecDocument();

  assert.equal(spec.spec_version, '5.0.0');
  assert.ok(spec.global_options.some((option) => option.name === '--agent'));
  assert.ok(spec.global_options.some((option) => option.name === '--interactive'));
  assert.ok(spec.global_options.some((option) => option.name === '--no-interactive'));
  assert.ok(spec.global_options.some((option) => option.name === '--experimental'));
  assert.ok(spec.commands.some((command) => command.name === 'search'));
  // search must not advertise --threshold in v5 (provider scores aren't comparable).
  const search = spec.commands.find((c) => c.name === 'search');
  assert.ok(search, 'search command must exist');
  const flags = search?.flags ?? [];
  assert.ok(!flags.some((f) => f.includes('--threshold')), 'search must not list --threshold');
  assert.ok(flags.some((f) => f.includes('--filter-json')), 'search must list --filter-json');
});

test('commandSpecDocument (help --json view) excludes hidden experimental commands', () => {
  // Per the v5 contract, hidden commands are present in cli-spec.json
  // (so parser/drift/capability gating can find them) but absent from
  // the help-facing machine document. spec-loader.test.ts asserts they
  // exist in the full loader view.
  const spec = commandSpecDocument();
  for (const hidden of ['lifecycle', 'audit', 'lessons', 'agents']) {
    assert.equal(
      spec.commands.some((c) => c.name === hidden),
      false,
      `commandSpecDocument must NOT expose hidden command "${hidden}"`,
    );
  }
  // Belt-and-suspenders: no command in the help-facing document carries
  // hidden:true.
  assert.equal(
    spec.commands.some((c) => c.hidden === true),
    false,
    'commandSpecDocument must contain no hidden:true entries',
  );
});

test('runtime command is excluded from v5 spec (no matching SDK extension)', () => {
  const spec = commandSpecDocument();
  assert.ok(!spec.commands.some((c) => c.name === 'runtime'));
});
