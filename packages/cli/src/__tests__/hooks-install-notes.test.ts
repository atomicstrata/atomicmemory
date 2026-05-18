/**
 * @file Coverage for the install-plan operator-guidance notes added by
 * Hook Hardening Follow-Up Plan items 6a (Codex stop-threshold docs)
 * and 8a (PATH-verification reminder). Both are docs-shaped: nothing
 * gets injected into the generated host snippets — operators read the
 * notes and decide what to set in their own host env. These tests pin
 * that contract so a future install-plan change cannot silently drop
 * the guidance OR leak it into a snippet command.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hooks } from '../commands/setup/hooks/index.js';
import type { CommandContext } from '../commands/types.js';

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
      throw new Error('install must not init the adapter');
    },
    ...overrides,
  };
}

interface InstallPlan {
  host: string;
  notes: string[];
  snippets: Array<{ content: string }>;
}

async function planFor(host: 'codex' | 'claude-code'): Promise<InstallPlan> {
  const result = await hooks(ctx({ flags: { host } }));
  return result.data as InstallPlan;
}

test('install plan ALWAYS includes a PATH verification note (item 8a)', async () => {
  for (const host of ['codex', 'claude-code'] as const) {
    const plan = await planFor(host);
    const note = plan.notes.find((n) => /command -v atomicmemory/.test(n));
    assert.ok(note, `${host}: expected a "command -v atomicmemory" note; got: ${plan.notes.join(' | ')}`);
    // Reminder mentions the host hook environment specifically so
    // operators know WHERE to run the verification.
    assert.match(note!, /host hook environment/i);
  }
});

test('install plan does NOT inject `command -v atomicmemory` into the snippet command (8a — docs only)', async () => {
  for (const host of ['codex', 'claude-code'] as const) {
    const plan = await planFor(host);
    for (const snippet of plan.snippets) {
      assert.equal(
        /command -v atomicmemory/.test(snippet.content),
        false,
        `${host}: snippet must not include "command -v atomicmemory"; got: ${snippet.content}`,
      );
    }
  }
});

test('codex install plan includes Codex stop-threshold guidance (item 6a)', async () => {
  const plan = await planFor('codex');
  const note = plan.notes.find((n) => /ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS/.test(n));
  assert.ok(note, `expected a stop-threshold note; got: ${plan.notes.join(' | ')}`);
  // Recommended Codex value is around 40 — pin the documented number
  // so a future doc rewrite that removes the recommendation breaks
  // this test.
  assert.match(note!, /=40/);
  // Make sure the guidance explicitly says generated snippets do NOT
  // set the override (operator-controlled per the v5 no-fallback rule).
  assert.match(note!, /generated snippet does not set this/i);
});

test('codex install plan does NOT inject the stop-threshold env var into the snippet (6a)', async () => {
  const plan = await planFor('codex');
  for (const snippet of plan.snippets) {
    assert.equal(
      /ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS/.test(snippet.content),
      false,
      `snippet must not embed the override; got: ${snippet.content}`,
    );
  }
});

test('claude-code install plan explains the 200 default came from empirical Claude tuning (item 6a)', async () => {
  const plan = await planFor('claude-code');
  const note = plan.notes.find((n) => /STOP_MIN_ASSISTANT_CHARS=200/.test(n));
  assert.ok(note, `expected the 200-default explainer note; got: ${plan.notes.join(' | ')}`);
  assert.match(note!, /tuned for Claude Code/i);
  // And points operators at the override env var so they know how to
  // change it without the docs telling them what value to set.
  assert.match(note!, /ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS/);
});
