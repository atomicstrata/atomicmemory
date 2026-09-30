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

test('skill permissions include every first-party Cloud origin', () => {
  const manifest = readFileSync(
    resolve(PLUGIN_ROOT, 'skills/atomicmemory/skill.yaml'),
    'utf8',
  );
  for (const hostname of ['api.atomicstrata.ai', 'api.dev.atomicstrata.ai', 'api.staging.atomicstrata.ai']) {
    assert.match(manifest, new RegExp(`^\\s*- https://${hostname.replaceAll('.', '\\.')}\\s*$`, 'm'));
  }
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

test('explicit apiUrl wins over an API key default', async () => {
  const testPlugin = createOpenClawPlugin(async (config) => {
    assert.equal((config as { apiUrl: string }).apiUrl, 'https://memory.example.com');
    return { async callTool() { return { content: [] }; } };
  });
  const tools = registerWithConfig(testPlugin, {
    apiUrl: 'https://memory.example.com',
    apiKey: 'amc_cloud_test',
    provider: 'atomicmemory',
    scope: { user: 'pip' },
  });

  await tools.find((tool) => tool.name === 'memory_list')?.execute('list', {});
});

test('apiKey alone defaults the URL to AtomicMemory Cloud', async () => {
  const testPlugin = createOpenClawPlugin(async (config) => {
    assert.deepEqual(config, cloudConfig());
    return { async callTool() { return { content: [] }; } };
  });
  const tools = registerWithConfig(testPlugin, {
    apiKey: 'amc_cloud_test',
    provider: 'atomicmemory',
    scope: { user: 'pip', namespace: 'repo' },
  });

  await tools.find((tool) => tool.name === 'memory_list')?.execute('list', {});
});

test('unset apiUrl and apiKey default to local Core with local-dev-key', async () => {
  const testPlugin = createOpenClawPlugin(async (config) => {
    assert.equal((config as { apiUrl: string }).apiUrl, 'http://127.0.0.1:17350');
    assert.equal((config as { apiKey?: string }).apiKey, 'local-dev-key');
    return { async callTool() { return { content: [] }; } };
  });
  const tools = registerWithConfig(testPlugin, {
    provider: 'atomicmemory',
    scope: { user: 'pip' },
  });

  await tools.find((tool) => tool.name === 'memory_list')?.execute('list', {});
});

test('explicit Cloud URL fails closed without a project API key', async () => {
  const tools = registerWithConfig(plugin, {
    apiUrl: 'https://api.atomicstrata.ai',
    provider: 'atomicmemory',
    scope: { user: 'pip' },
  });
  const search = tools.find((tool) => tool.name === 'memory_search');
  assert.ok(search);

  await assert.rejects(
    () => search.execute('call-1', { query: 'remembered preference' }),
    /config\.apiKey for AtomicMemory Cloud/,
  );
});

test('equivalent Cloud origins cannot bypass the required project API key', async () => {
  const urls = [
    'https://API.atomicstrata.ai',
    'https://api.atomicstrata.ai:443/v1',
    'https://api.dev.atomicstrata.ai',
    'https://api.staging.atomicstrata.ai',
  ];
  for (const apiUrl of urls) {
    const tools = registerWithConfig(plugin, {
      apiUrl,
      provider: 'atomicmemory',
      scope: { user: 'pip' },
    });
    const search = tools.find((tool) => tool.name === 'memory_search');
    assert.ok(search);

    await assert.rejects(
      () => search.execute('call-1', { query: 'remembered preference' }),
      /config\.apiKey for AtomicMemory Cloud/,
    );
  }
});

test('Cloud missing-key error points local Core users at the local URL', async () => {
  const tools = registerWithConfig(plugin, {
    apiUrl: 'https://api.atomicstrata.ai',
    provider: 'atomicmemory',
    scope: { user: 'pip' },
  });
  await assert.rejects(
    () => tools.find((tool) => tool.name === 'memory_search')!.execute('call-1', { query: 'q' }),
    /local Core users should set config\.apiUrl to http:\/\/127\.0\.0\.1:17350/,
  );
});

test('the local Core key is refused for Cloud origins before any MCP caller starts', async () => {
  const urls = [
    undefined,
    'https://api.atomicstrata.ai',
    'https://API.atomicstrata.ai:443/v1',
    'https://api.dev.atomicstrata.ai',
    'https://api.staging.atomicstrata.ai',
  ];
  for (const apiUrl of urls) {
    for (const apiKey of ['local-dev-key', '  local-dev-key  ']) {
      let started = false;
      const testPlugin = createOpenClawPlugin(async () => {
        started = true;
        return { async callTool() { return { content: [] }; } };
      });
      const tools = registerWithConfig(testPlugin, {
        ...(apiUrl ? { apiUrl } : {}),
        apiKey,
        provider: 'atomicmemory',
        scope: { user: 'pip' },
      });
      await assert.rejects(
        () => tools.find((tool) => tool.name === 'memory_list')!.execute('list', {}),
        /local Core key[\s\S]*http:\/\/127\.0\.0\.1:17350/,
      );
      assert.equal(started, false, `MCP caller must not start for ${apiUrl ?? 'default'}`);
    }
  }
});

test('plain http to a Cloud hostname fails closed', async () => {
  for (const apiUrl of [
    'http://api.atomicstrata.ai',
    'HTTP://API.atomicstrata.ai:80/v1',
    'http://api.dev.atomicstrata.ai:8080',
    'http://api.staging.atomicstrata.ai.',
  ]) {
    let started = false;
    const testPlugin = createOpenClawPlugin(async () => {
      started = true;
      return { async callTool() { return { content: [] }; } };
    });
    const tools = registerWithConfig(testPlugin, {
      apiUrl,
      apiKey: 'amc_cloud_test',
      provider: 'atomicmemory',
      scope: { user: 'pip' },
    });
    await assert.rejects(
      () => tools.find((tool) => tool.name === 'memory_list')!.execute('list', {}),
      /requires https for AtomicMemory Cloud/,
    );
    assert.equal(started, false, `MCP caller must not start for ${apiUrl}`);
  }
});

test('both documented local Core origins receive the development key', async () => {
  const urls = [
    'http://127.0.0.1:17350',
    'http://localhost:17350',
    'HTTP://LOCALHOST:17350',
    'http://localhost:017350',
  ];
  for (const apiUrl of urls) {
    const testPlugin = createOpenClawPlugin(async (config) => {
      assert.equal((config as { apiKey?: string }).apiKey, 'local-dev-key');
      return { async callTool() { return { content: [] }; } };
    });
    const tools = registerWithConfig(testPlugin, {
      apiUrl,
      provider: 'atomicmemory',
      scope: { user: 'pip' },
    });

    await tools.find((tool) => tool.name === 'memory_list')?.execute('list', {});
  }
});

test('custom deployments retain their own authentication policy', async () => {
  const testPlugin = createOpenClawPlugin(async (config) => {
    assert.equal((config as { apiKey?: string }).apiKey, undefined);
    return { async callTool() { return { content: [] }; } };
  });
  const tools = registerWithConfig(testPlugin, {
    apiUrl: 'https://memory.example.com',
    provider: 'atomicmemory',
    scope: { user: 'pip' },
  });

  await tools.find((tool) => tool.name === 'memory_list')?.execute('list', {});
});

test('Cloud config routes write and retrieve through the embedded MCP caller', async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const testPlugin = createOpenClawPlugin(async (config) => {
    assert.deepEqual(config, cloudConfig());
    return {
      async callTool(input) {
        calls.push(input);
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    };
  });
  const tools = registerWithConfig(testPlugin, {
    apiKey: 'amc_cloud_test',
    provider: 'atomicmemory',
    scope: { user: 'pip', namespace: 'repo' },
  });

  await tools.find((tool) => tool.name === 'memory_ingest')?.execute('write', {
    mode: 'text', content: 'prefers concise answers',
  });
  await tools.find((tool) => tool.name === 'memory_search')?.execute('read', {
    query: 'answer preference',
  });

  assert.deepEqual(calls.map((call) => call.name), ['memory_ingest', 'memory_search']);
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
  const tools = registerWithConfig(testPlugin, {
    apiKey: ' amc_cloud_test ',
    provider: 'atomicmemory',
    scope: { user: 'pip', namespace: 'repo' },
  });
  const list = tools.find((tool) => tool.name === 'memory_list');
  assert.ok(list);
  assert.equal(createdConfigs.length, 0);

  const first = await list.execute('call-1', { limit: 1 });
  const second = await list.execute('call-2', { limit: 2 });

  assert.deepEqual(createdConfigs, [cloudConfig()]);
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

function registerWithConfig(
  testPlugin: typeof plugin,
  pluginConfig: NonNullable<Parameters<typeof testPlugin.register>[0]['pluginConfig']> = {
    apiUrl: 'http://127.0.0.1:17350///',
    apiKey: ' local-dev-key ',
    provider: 'atomicmemory' as const,
    scope: { user: 'pip', namespace: 'repo' },
  },
) {
  const tools: Array<Parameters<Parameters<typeof testPlugin.register>[0]['registerTool']>[0]> = [];
  testPlugin.register({
    pluginConfig,
    registerTool(tool) {
      tools.push(tool);
    },
  });
  return tools;
}

function cloudConfig() {
  return {
    apiUrl: 'https://api.atomicstrata.ai',
    apiKey: 'amc_cloud_test',
    provider: 'atomicmemory',
    scope: { user: 'pip', namespace: 'repo' },
  };
}
