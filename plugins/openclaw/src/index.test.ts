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

function registerWithConfig(testPlugin: typeof plugin) {
  const tools: Array<Parameters<Parameters<typeof testPlugin.register>[0]['registerTool']>[0]> = [];
  testPlugin.register({
    pluginConfig: {
      apiUrl: 'http://127.0.0.1:3050///',
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
    apiUrl: 'http://127.0.0.1:3050',
    apiKey: 'local-dev-key',
    provider: 'atomicmemory',
    scope: { user: 'pip', namespace: 'repo' },
  };
}
