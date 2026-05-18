/**
 * @file Bidirectional CLI<->SDK scope translation tests.
 *
 *   - cliScopeToSdkScope: agent_id collapses to agent
 *   - sdkScopeToCliScope: agent expands to agent_id
 *   - sdkCapabilitiesToCli: every requiredScope entry (default + ops)
 *     is rewritten so callers see canonical agent_id, never agent
 *   - sdkScopeFieldToCli: pure rename
 *   - sdkMemoryToCli / sdkProvenanceToCli: round-trip on dates and
 *     provenance subfields
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cliProvenanceToSdk,
  cliScopeToSdkScope,
  sdkCapabilitiesToCli,
  sdkMemoryToCli,
  sdkProvenanceToCli,
  sdkScopeFieldToCli,
  sdkScopeToCliScope,
} from '../adapters/scope-mapper.js';
import { CliError } from '../types.js';
import type {
  Capabilities as SdkCapabilities,
  Memory as SdkMemory,
  Scope as SdkScope,
} from '@atomicmemory/sdk';

test('cliScopeToSdkScope rewrites agent_id to agent and preserves the rest', () => {
  const sdk = cliScopeToSdkScope({
    user: 'u1',
    agent_id: 'a1',
    namespace: 'n1',
    thread: 't1',
  });
  assert.deepEqual(sdk, {
    user: 'u1',
    agent: 'a1',
    namespace: 'n1',
    thread: 't1',
  });
  // agent_id is NOT carried into the SDK shape.
  assert.equal((sdk as Record<string, unknown>).agent_id, undefined);
});

test('cliScopeToSdkScope omits unset optionals (no `agent_id: undefined` key)', () => {
  const sdk = cliScopeToSdkScope({ user: 'u1' });
  assert.deepEqual(sdk, { user: 'u1' });
  assert.equal('agent' in sdk, false);
});

test('sdkScopeToCliScope rewrites agent to agent_id', () => {
  const cli = sdkScopeToCliScope({
    user: 'u1',
    agent: 'a1',
    namespace: 'n1',
  });
  assert.equal(cli.user, 'u1');
  assert.equal(cli.agent_id, 'a1');
  assert.equal(cli.namespace, 'n1');
  assert.equal((cli as Record<string, unknown>).agent, undefined);
});

test('sdkScopeToCliScope fails closed when scope is undefined (no synthesized user)', () => {
  assert.throws(
    () => sdkScopeToCliScope(undefined),
    (e: unknown) =>
      e instanceof CliError &&
      e.code === 'runtime' &&
      /scope\.user/.test(e.message),
  );
});

test('sdkScopeToCliScope fails closed when scope omits user', () => {
  // Cast through unknown because SdkScope.user is required by the SDK
  // type; a malformed provider response is the runtime hazard we are
  // guarding against.
  const malformed = { agent: 'a1' } as unknown as SdkScope;
  assert.throws(
    () => sdkScopeToCliScope(malformed),
    (e: unknown) =>
      e instanceof CliError && e.code === 'runtime',
  );
});

test('sdkScopeToCliScope fails closed when scope.user is the empty string', () => {
  const malformed = { user: '' } as SdkScope;
  assert.throws(
    () => sdkScopeToCliScope(malformed),
    (e: unknown) =>
      e instanceof CliError && e.code === 'runtime',
  );
});

test('sdkMemoryToCli propagates the runtime error when memory.scope lacks user', () => {
  // The mapper delegates to sdkScopeToCliScope so the same protocol-
  // violation surface bubbles up.
  const malformed: SdkMemory = {
    id: 'mem_x',
    content: 'c',
    scope: { agent: 'a1' } as unknown as SdkScope,
    createdAt: new Date('2026-05-08T10:00:00Z'),
  };
  assert.throws(
    () => sdkMemoryToCli(malformed),
    (e: unknown) =>
      e instanceof CliError && e.code === 'runtime',
  );
});

test('sdkScopeFieldToCli is a pure rename for agent and pass-through for the rest', () => {
  assert.equal(sdkScopeFieldToCli('agent'), 'agent_id');
  assert.equal(sdkScopeFieldToCli('user'), 'user');
  assert.equal(sdkScopeFieldToCli('namespace'), 'namespace');
  assert.equal(sdkScopeFieldToCli('thread'), 'thread');
});

test('sdkCapabilitiesToCli rewrites every requiredScope entry to CLI fields', () => {
  const sdk: SdkCapabilities = {
    ingestModes: ['text', 'messages'],
    requiredScope: {
      default: ['user', 'agent'],
      search: ['user', 'agent', 'namespace'],
      get: ['user'],
    },
    extensions: {
      update: false,
      package: false,
      temporal: false,
      graph: false,
      forget: false,
      profile: false,
      reflect: false,
      versioning: false,
      batch: false,
      health: false,
    },
    supportedRerankers: ['mmr'],
    maxTokenBudget: 4096,
  };
  const cli = sdkCapabilitiesToCli(sdk);
  assert.deepEqual(cli.requiredScope?.default, ['user', 'agent_id']);
  assert.deepEqual(cli.requiredScope?.search, ['user', 'agent_id', 'namespace']);
  assert.deepEqual(cli.requiredScope?.get, ['user']);
  // Pass-through fields stay intact.
  assert.deepEqual(cli.ingestModes, ['text', 'messages']);
  assert.equal(cli.maxTokenBudget, 4096);
  assert.deepEqual(cli.supportedRerankers, ['mmr']);
  assert.equal(cli.extensions.package, false);
});

test('sdkCapabilitiesToCli preserves the requiredScope.default fallback path', () => {
  // Phase 3's assertDynamicScope falls back to requiredScope.default when
  // the operation-specific entry is missing. After CLI translation the
  // `default` key must still exist with CLI field names so the fallback
  // continues to match.
  const sdk: SdkCapabilities = {
    ingestModes: ['text'],
    requiredScope: {
      default: ['user', 'agent'],
      // no operation-specific entries; only `default` is provided
    },
    extensions: {
      update: false,
      package: true,
      temporal: false,
      graph: false,
      forget: false,
      profile: false,
      reflect: false,
      versioning: false,
      batch: false,
      health: false,
    },
  };
  const cli = sdkCapabilitiesToCli(sdk);
  assert.ok(cli.requiredScope);
  assert.deepEqual(cli.requiredScope?.default, ['user', 'agent_id']);
  // CLI fall-through path: assertDynamicScope({...}, 'whatever', cli)
  // would consult `default` since 'whatever' has no entry, and would
  // see canonical agent_id (not agent).
});

test('sdkMemoryToCli normalizes dates to ISO strings and rewrites scope.agent', () => {
  const memory: SdkMemory = {
    id: 'mem_1',
    content: 'hello',
    scope: { user: 'u1', agent: 'a1' },
    kind: 'fact',
    createdAt: new Date('2026-05-08T10:00:00Z'),
    metadata: { foo: 'bar' },
  };
  const cli = sdkMemoryToCli(memory);
  assert.equal(cli.id, 'mem_1');
  assert.equal(cli.content, 'hello');
  assert.equal(cli.kind, 'fact');
  assert.equal(cli.scope.agent_id, 'a1');
  assert.equal((cli.scope as Record<string, unknown>).agent, undefined);
  assert.equal(cli.createdAt, '2026-05-08T10:00:00.000Z');
  assert.deepEqual(cli.metadata, { foo: 'bar' });
});

test('provenance round-trips through cliProvenanceToSdk + sdkProvenanceToCli', () => {
  const cli = {
    source: 'codex',
    sourceUrl: 'https://example.com',
    sourceId: 'abc',
    extractor: 'v5-extractor',
  };
  const sdk = cliProvenanceToSdk(cli);
  const round = sdkProvenanceToCli(sdk);
  assert.deepEqual(round, cli);
});
