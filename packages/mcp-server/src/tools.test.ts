/**
 * @file Tests for the MCP `memory_ingest` handler — caller-supplied
 *       metadata forwarding on the verbatim path.
 *
 * Background. `ingestVerbatim` previously called the namespaced
 * `client.atomicmemory.ingestQuick(input, scope, { skipExtraction })`
 * handle, whose options-arg type is `{ skipExtraction?: boolean }`
 * with no metadata slot. Result: caller-supplied `args.metadata`
 * was extracted only for `dedupe_key` URL synthesis, never reached
 * the wire body.
 *
 * After atomicmemory-core PR #51 added the wire path, atomicmemory-sdk
 * PR #15 wired metadata through `client.ingest`'s HTTP body builder
 * (verbatim-only, runtime-gated). This module switched to
 * `client.ingest({ mode: 'verbatim', ..., metadata })` to consume
 * that path. The tests below pin the new contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers, type IngestArgs } from './tools.js';
import type {
  IngestInput,
  IngestResult,
  MemoryClient,
} from '@atomicmemory/sdk';

interface FakeClient {
  client: MemoryClient;
  ingestCalls: IngestInput[];
}

interface FakeClientOptions {
  /**
   * Whether the client should report itself as AtomicMemory-provider-backed
   * (defaults true). Set false to simulate a non-AtomicMemory configuration
   * such as `provider=mem0`, where verbatim ingest must fail fast.
   */
  hasAtomicMemory?: boolean;
}

function makeFakeClient(options: FakeClientOptions = {}): FakeClient {
  const ingestCalls: IngestInput[] = [];
  const hasAtomicMemory = options.hasAtomicMemory ?? true;
  const client = {
    async ingest(input: IngestInput): Promise<IngestResult> {
      ingestCalls.push(input);
      return {
        created: ['fake-mem-id'],
        updated: [],
        unchanged: [],
      } as unknown as IngestResult;
    },
    // Mirrors `MemoryClient.atomicmemory` — present iff an
    // AtomicMemoryProvider is registered. The MCP layer's guard
    // checks truthiness only; a sentinel object is enough.
    atomicmemory: hasAtomicMemory ? { __provider: 'atomicmemory' } : undefined,
  } as unknown as MemoryClient;
  return { client, ingestCalls };
}

const SCOPE = { user: '00000000-0000-0000-0000-000000000abc' };

test('memory_ingest verbatim — forwards caller metadata to client.ingest unchanged', async () => {
  const fake = makeFakeClient();
  const handlers = createHandlers(fake.client, undefined);

  const args: IngestArgs = {
    mode: 'verbatim',
    content: 'verbatim payload',
    scope: SCOPE,
    metadata: {
      event: 'task_completed',
      session_id: 'session-xyz',
      tool_count: 3,
    },
  };
  await handlers.memory_ingest(args);

  assert.equal(fake.ingestCalls.length, 1);
  const call = fake.ingestCalls[0]!;
  assert.equal(call.mode, 'verbatim');
  // The full caller metadata round-trips through to `client.ingest`.
  // The SDK provider (post PR #15) is responsible for forwarding it
  // onto the HTTP body; this test pins the MCP-side contract.
  assert.deepEqual(call.metadata, {
    event: 'task_completed',
    session_id: 'session-xyz',
    tool_count: 3,
  });
});

test('memory_ingest verbatim — passes provenance.source / sourceUrl through', async () => {
  const fake = makeFakeClient();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_ingest({
    mode: 'verbatim',
    content: 'p1',
    scope: SCOPE,
    provenance: { source: 'claude-code', sourceUrl: 'https://example.com/x' },
  });

  const call = fake.ingestCalls[0]!;
  assert.equal(call.provenance?.source, 'claude-code');
  assert.equal(call.provenance?.sourceUrl, 'https://example.com/x');
});

test('memory_ingest text — forwards caller metadata to client.ingest unchanged', async () => {
  const fake = makeFakeClient();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_ingest({
    mode: 'text',
    content: 'Decision: store clean content and separate metadata.',
    scope: SCOPE,
    metadata: {
      event: 'decision',
      source: 'codex',
    },
  });

  const call = fake.ingestCalls[0]!;
  assert.equal(call.mode, 'text');
  assert.deepEqual(call.metadata, {
    event: 'decision',
    source: 'codex',
  });
});

test('memory_ingest verbatim — synthesizes sourceUrl from metadata.dedupe_key when caller omits provenance.sourceUrl', async () => {
  const fake = makeFakeClient();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_ingest({
    mode: 'verbatim',
    content: 'p2',
    scope: SCOPE,
    metadata: { dedupe_key: 'abc-123' },
  });

  const call = fake.ingestCalls[0]!;
  assert.equal(
    call.provenance?.sourceUrl,
    'atomicmemory://mcp/verbatim/abc-123',
  );
  // dedupe_key still rides on metadata for downstream readers.
  assert.equal(
    (call.metadata as { dedupe_key?: string } | undefined)?.dedupe_key,
    'abc-123',
  );
});

test('memory_ingest verbatim — passes empty metadata object through when caller did not supply', async () => {
  // The MCP layer normalizes missing metadata to `{}`. The SDK
  // provider (PR #15) treats `{}` as no-metadata and omits the
  // field from the wire body — that gate is asserted SDK-side.
  // Here we just verify the MCP layer doesn't fabricate keys.
  const fake = makeFakeClient();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_ingest({
    mode: 'verbatim',
    content: 'p3',
    scope: SCOPE,
  });

  const call = fake.ingestCalls[0]!;
  assert.deepEqual(call.metadata, {});
});

test('memory_ingest verbatim — throws when scope.user is absent (core requires user-scope on quick ingest)', async () => {
  const fake = makeFakeClient();
  const handlers = createHandlers(fake.client, undefined);

  await assert.rejects(
    () =>
      handlers.memory_ingest({
        mode: 'verbatim',
        content: 'p4',
        // scope intentionally omitted; mergeScope will throw earlier
        // with a different message, but the verbatim-specific
        // user-required check is the contract we're locking in.
        scope: { agent: 'agent-only' },
      }),
    /scope.user|user-scope|user/i,
  );
});

test('memory_ingest verbatim — throws when client has no AtomicMemory provider (e.g. provider=mem0)', async () => {
  // Codex round-1 residual-risk note: the SDK eventually rejects
  // non-AtomicMemory + verbatim via its capability gate, but with
  // a generic "mode not supported" message. The MCP layer's
  // explicit guard surfaces the actionable diagnosis (point the
  // operator at provider config, not SDK internals) and short-
  // circuits before the generic `client.ingest` call.
  const fake = makeFakeClient({ hasAtomicMemory: false });
  const handlers = createHandlers(fake.client, undefined);

  await assert.rejects(
    () =>
      handlers.memory_ingest({
        mode: 'verbatim',
        content: 'p5',
        scope: SCOPE,
        metadata: { event: 'should-not-be-sent' },
      }),
    /AtomicMemory provider/i,
  );
  // Sanity: the call short-circuits before any HTTP attempt.
  assert.equal(fake.ingestCalls.length, 0);
});
