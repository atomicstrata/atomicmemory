/**
 * @file Regression tests for OpenClaw plugin registration behavior.
 *       OpenClaw loads plugins for inventory commands such as
 *       `openclaw plugins list`; registration must therefore stay
 *       synchronous and must not start the embedded MCP server until a
 *       memory tool is actually executed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import plugin, { createOpenClawPlugin } from './index.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOL_NAMES = ['memory_ingest', 'memory_list', 'memory_package', 'memory_search'];

test('manifest declares contracts.tools matching the tools register() exposes', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(PLUGIN_ROOT, 'openclaw.plugin.json'), 'utf8'),
  );
  assert.ok(manifest.contracts, 'openclaw.plugin.json must declare a contracts block');
  assert.ok(Array.isArray(manifest.contracts.tools), 'contracts.tools must be an array');
  assert.deepEqual(
    [...manifest.contracts.tools].sort(),
    EXPECTED_TOOL_NAMES,
    'contracts.tools must match the tools register() actually exposes',
  );
});

test('register exposes memory tools without requiring provider config', () => {
  const tools: Array<{ name: string }> = [];

  plugin.register({
    registerTool(tool) {
      tools.push({ name: tool.name });
    },
  });

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['memory_ingest', 'memory_list', 'memory_package', 'memory_search'],
  );
});

test('execute lazily creates one MCP caller and parses result details', async () => {
  const createdConfigs: unknown[] = [];
  const toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const testPlugin = createOpenClawPlugin(async (config) => {
    createdConfigs.push(config);
    return {
      async callTool(input) {
        toolCalls.push(input);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, call: toolCalls.length }) }] };
      },
    };
  });
  const tools = registerWithConfig(testPlugin);
  const list = tools.find((tool) => tool.name === 'memory_list');
  assert.ok(list);
  assert.equal(createdConfigs.length, 0);

  const first = await list.execute('call-1', { limit: 1 });
  const second = await list.execute('call-2', { limit: 2 });

  assert.deepEqual(createdConfigs, [normalizedConfig()]);
  assert.deepEqual(toolCalls, [
    { name: 'memory_list', arguments: { limit: 1 } },
    { name: 'memory_list', arguments: { limit: 2 } },
  ]);
  assert.deepEqual(first.details, { ok: true, call: 1 });
  assert.deepEqual(second.details, { ok: true, call: 2 });
  assert.deepEqual(first.content, [{ type: 'text', text: '{"ok":true,"call":1}' }]);
});

test('memory_ingest schema accepts contentClass as a top-level property', () => {
  const tools = registerWithConfig(plugin);
  const ingest = tools.find((tool) => tool.name === 'memory_ingest');
  assert.ok(ingest, 'memory_ingest must be registered');

  const schema = ingest.parameters as {
    additionalProperties?: boolean;
    properties?: Record<string, { enum?: string[] }>;
  };

  // The schema forbids unknown properties, so a missing declaration does not
  // degrade to "passed through" - it is rejected before reaching MCP. That is
  // what made verbatim ingest impossible against a default-policy core while
  // the shipped skill instructions told the agent to send it.
  assert.equal(
    schema.additionalProperties,
    false,
    'schema is closed, so contentClass must be declared explicitly',
  );
  assert.ok(
    schema.properties?.contentClass,
    'memory_ingest must declare contentClass; the skill instructions require it',
  );
  assert.deepEqual(schema.properties?.contentClass?.enum, ['summary', 'redacted', 'raw']);
});

test('memory_ingest forwards contentClass to MCP as a top-level argument', async () => {
  const toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const testPlugin = createOpenClawPlugin(async () => ({
    async callTool(input) {
      toolCalls.push(input);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  }));

  const tools = registerWithConfig(testPlugin);
  const ingest = tools.find((tool) => tool.name === 'memory_ingest');
  assert.ok(ingest, 'memory_ingest must be registered');

  const params = {
    mode: 'verbatim',
    content: 'session snapshot',
    contentClass: 'summary',
  };

  // execute() does not itself validate, so tie the payload to the declared
  // schema: the host rejects undeclared top-level keys before execute is ever
  // reached. Without this, the test would pass against a schema missing
  // contentClass and prove nothing about the bug it guards.
  const declared = (ingest.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  for (const key of Object.keys(params)) {
    assert.ok(
      key in declared,
      `memory_ingest schema must declare '${key}'; the schema is closed so the host would reject this call`,
    );
  }

  await ingest.execute('call-1', params);

  assert.equal(toolCalls.length, 1);
  // Top-level, NOT nested under metadata. Core reads content_class from the
  // top level; a metadata-nested copy is ignored and still 422s, which is
  // exactly what the model fell back to when the property was undeclared.
  assert.equal(toolCalls[0]?.arguments?.contentClass, 'summary');
  assert.equal(
    (toolCalls[0]?.arguments?.metadata as Record<string, unknown> | undefined)?.contentClass,
    undefined,
    'contentClass must not be smuggled through metadata',
  );
});

function registerWithConfig(testPlugin: typeof plugin) {
  const tools: Array<Parameters<Parameters<typeof testPlugin.register>[0]['registerTool']>[0]> = [];
  testPlugin.register({
    pluginConfig: {
      apiUrl: 'http://127.0.0.1:17350///',
      apiKey: ' local-dev-key ',
      provider: 'atomicmemory',
      scope: { user: 'pip', namespace: 'repo' },
    },
    registerTool(tool) {
      tools.push(tool);
    },
  });
  return tools;
}

function normalizedConfig() {
  return {
    apiUrl: 'http://127.0.0.1:17350',
    apiKey: 'local-dev-key',
    provider: 'atomicmemory',
    scope: { user: 'pip', namespace: 'repo' },
  };
}
