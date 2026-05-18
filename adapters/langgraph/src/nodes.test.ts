/**
 * @file Tests for the node factories - scope-binding, getQuery /
 *       applyContext plumbing, null-context propagation, ingest
 *       no-state-effect default, and getMessages / getCompletion
 *       plumbing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryIngestNode,
  createMemoryRetrieveNode,
} from './nodes.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';
import type { Message } from '@atomicmemory/sdk';

interface DemoState {
  readonly latestUser: string;
  readonly messages: readonly Message[];
  readonly completion: string;
  readonly context?: string | null;
}

const scope = { user: 'u1' };

test('retrieve node merges rendered context into state via applyContext', async () => {
  const { client } = makeFakeClient({ searchResults: [makeMemory('fact-x')] });
  const node = createMemoryRetrieveNode<DemoState, Partial<DemoState>>(client, {
    scope,
    getQuery: (s) => s.latestUser,
    applyContext: (_s, context) => ({ context }),
  });
  const update = await node({ latestUser: 'q', messages: [], completion: '' });
  assert.match(update.context ?? '', /fact-x/);
  assert.match(update.context ?? '', /<atomicmemory:context>/);
});

test('retrieve node propagates null context on no match', async () => {
  const { client } = makeFakeClient({ searchResults: [] });
  const node = createMemoryRetrieveNode<DemoState, Partial<DemoState>>(client, {
    scope,
    getQuery: () => 'q',
    applyContext: (_s, context) => ({ context }),
  });
  const update = await node({ latestUser: 'q', messages: [], completion: '' });
  assert.equal(update.context, null);
});

test('retrieve node binds scope at factory time (state cannot rebind)', async () => {
  const { client, searchCalls } = makeFakeClient();
  const fixedScope = { user: 'pip', namespace: 'graph' };
  const node = createMemoryRetrieveNode<DemoState, Partial<DemoState>>(client, {
    scope: fixedScope,
    getQuery: (s) => s.latestUser,
    applyContext: () => ({}),
  });
  await node({ latestUser: 'q', messages: [], completion: '' });
  assert.deepEqual(searchCalls[0]?.scope, fixedScope);
});

test('retrieve node forwards limit + formatter overrides', async () => {
  const { client, searchCalls } = makeFakeClient({
    searchResults: [makeMemory('fact-y')],
  });
  const node = createMemoryRetrieveNode<DemoState, Partial<DemoState>>(client, {
    scope,
    limit: 9,
    formatter: (rs) => `CUSTOM:${rs.length}`,
    getQuery: () => 'q',
    applyContext: (_s, context) => ({ context }),
  });
  const update = await node({ latestUser: 'q', messages: [], completion: '' });
  assert.equal(searchCalls[0]?.limit, 9);
  assert.equal(update.context, 'CUSTOM:1');
});

test('ingest node ingests via messages mode + returns empty update by default', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const node = createMemoryIngestNode<DemoState, never>(client, {
    scope,
    getMessages: (s) => s.messages,
    getCompletion: (s) => s.completion,
  });
  const update = await node({
    latestUser: 'q',
    messages: [{ role: 'user', content: 'q' }],
    completion: 'a',
  });
  const sent = ingestCalls[0];
  assert.equal(sent?.mode, 'messages');
  assert.equal(sent?.mode === 'messages' && sent.messages.at(-1)?.role, 'assistant');
  assert.equal(sent?.mode === 'messages' && sent.messages.at(-1)?.content, 'a');
  assert.deepEqual(update, {});
});

test('ingest node forwards applyIngestResult to produce state side-effects', async () => {
  const { client } = makeFakeClient();
  interface AuditState { ingestCount: number }
  const node = createMemoryIngestNode<DemoState, Partial<AuditState>>(client, {
    scope,
    getMessages: (s) => s.messages,
    getCompletion: (s) => s.completion,
    applyIngestResult: () => ({ ingestCount: 1 }),
  });
  const update = await node({
    latestUser: 'q',
    messages: [{ role: 'user', content: 'q' }],
    completion: 'a',
  });
  assert.deepEqual(update, { ingestCount: 1 });
});

test('ingest node forwards includeRoles override', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const node = createMemoryIngestNode<DemoState, never>(client, {
    scope,
    includeRoles: ['system', 'user', 'assistant'],
    getMessages: (s) => s.messages,
    getCompletion: (s) => s.completion,
  });
  await node({
    latestUser: 'q',
    messages: [
      { role: 'system', content: 'POLICY' },
      { role: 'user', content: 'q' },
    ],
    completion: 'a',
  });
  const sent = ingestCalls[0];
  const sentMessages = sent?.mode === 'messages' ? sent.messages : [];
  assert.ok(sentMessages.some((m) => m.role === 'system'));
});
