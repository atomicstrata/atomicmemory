/** Verify candidate packed exports with local dependency artifacts, never publish. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = dirname(dirname(fileURLToPath(import.meta.url)));
const consumer = await mkdtemp(join(tmpdir(), 'atomicmemory-ai-packed-'));
const sdk = join(adapter, '../../packages/sdk');
const ai = process.env.AI_SDK_VERSION ?? '7.0.181';
const zod = process.env.ZOD_VERSION ?? '3.25.76';

function run(command, args, cwd = consumer, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
}

async function pack(directory) {
  run('pnpm', ['pack', '--pack-destination', consumer], directory);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  return join(consumer, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
}

async function unpack(archive) {
  const destination = join(consumer, 'root/node_modules/@atomicmemory/vercel-ai');
  await mkdir(destination, { recursive: true });
  run('tar', ['-xzf', archive, '-C', destination, '--strip-components=1']);
  assert.deepEqual((await readdir(join(destination, 'dist'))).filter(name => name.startsWith('test-fixtures')), []);
  await writeFile(join(consumer, 'root/package.json'), JSON.stringify({ type: 'module' }));
}

async function install(archive, sdkArchive) {
  assert.match(ai, /^[567]\.\d+\.\d+$/);
  assert.match(zod, /^[34]\.\d+\.\d+$/);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    type: 'module', dependencies: {
      '@atomicmemory/vercel-ai': `file:${process.env.LINKED_ADAPTER === 'injected' ? adapter : archive}`,
      ai, zod,
    }, devDependencies: { '@types/json-schema': '7.0.15' },
    dependenciesMeta: { '@atomicmemory/vercel-ai': { injected: true } },
    pnpm: { overrides: { '@atomicmemory/sdk': `file:${sdkArchive}` } },
  }));
  run('pnpm', ['install', '--ignore-scripts', '--strict-peer-dependencies']);
  if (process.env.LINKED_ADAPTER === '1') {
    const installed = join(consumer, 'node_modules/@atomicmemory/vercel-ai');
    await rm(installed);
    await symlink(adapter, installed);
  }
}

async function verifyRoot() {
  await writeFile(join(consumer, 'deny-sdk.mjs'), `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@atomicmemory/sdk' || specifier.startsWith('@atomicmemory/sdk/')) {
    throw new Error('Unexpected SDK runtime import');
  }
  return nextResolve(specifier, context);
}
`);
  await writeFile(join(consumer, 'root/deny-peers.mjs'), `
import { resolve as resolveSDK } from '../deny-sdk.mjs';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ai' || specifier.startsWith('ai/') || specifier === 'zod' || specifier.startsWith('zod/')) {
    throw new Error('Unexpected optional peer runtime import');
  }
  return resolveSDK(specifier, context, nextResolve);
}
`);
  await writeFile(join(consumer, 'root/root.mjs'), `
import assert from 'node:assert/strict';
import * as root from '@atomicmemory/vercel-ai';
assert.deepEqual(Object.keys(root).sort(), [
  'augmentWithMemory', 'defaultFormatter', 'fromModelMessage', 'fromModelMessages',
  'ingestTurn', 'retrieve', 'withMemory',
]);
assert.deepEqual(root.fromModelMessage({ role: 'user', content: 'tea' }), { role: 'user', content: 'tea' });
`);
  run(process.execPath, ['--loader', './deny-peers.mjs', './root.mjs'], join(consumer, 'root'));
}

async function verifyTools() {
  await writeFile(join(consumer, 'tools.mjs'), `
import assert from 'node:assert/strict';
import { createMemory, memoryTools } from '@atomicmemory/vercel-ai/tools';
assert.throws(() => memoryTools({}), { message: 'Memory tools configuration is invalid.' });
assert.equal(typeof createMemory, 'function');
`);
  run(process.execPath, ['--loader', './deny-sdk.mjs', './tools.mjs']);
  await writeFile(join(consumer, 'consumer.ts'), `
import { createMemory, memoryTools, type MemoryToolsClient } from '@atomicmemory/vercel-ai/tools';
import { generateText, streamText, stepCountIs, type InferToolInput, type InferToolOutput, type ToolSet, type LanguageModel } from 'ai';
declare const client: MemoryToolsClient;
declare const model: LanguageModel;
const tools = memoryTools({ client, scope: { user: 'authenticated-user' } }) satisfies ToolSet;
const input: InferToolInput<typeof tools.memory_search> = { query: 'tea', limit: 5 };
// @ts-expect-error Inferred query must remain a string, not any.
input.query = 42;
// @ts-expect-error Model-controlled scope must remain disallowed.
const invalid: InferToolInput<typeof tools.memory_ingest> = { content: 'tea', scope: { user: 'other' } };
// @ts-expect-error Scores remain numeric in inferred search output.
const invalidOutput: InferToolOutput<typeof tools.memory_search> = { results: [{ id: 'tea', content: 'tea', score: '2', truncated: false }], truncated: false };
// @ts-expect-error Ingest returns actual ID arrays, never numeric IDs.
const invalidIDs: InferToolOutput<typeof tools.memory_ingest> = { created: [1], updated: [], unchanged: [] };
generateText({ model, tools, prompt: input.query, stopWhen: stepCountIs(3) });
const memory = await createMemory({ client });
const readOnly = memory.toolsForUser('authenticated-user');
const writable = memory.toolsForUser('authenticated-user', { allowWrites: true });
// @ts-expect-error Writes are not exposed without an explicit opt-in.
readOnly.memory_ingest;
generateText({ model, tools: writable, prompt: 'tea', stopWhen: stepCountIs(3) });
streamText({ model, tools: readOnly, prompt: 'tea', stopWhen: stepCountIs(3) });
`);
  const flags = ['exec', 'tsc', '--noEmit', '--strict', '--module', 'NodeNext',
    '--target', 'ES2022', '--lib', 'ES2022,DOM', join(consumer, 'consumer.ts')];
  run('pnpm', flags, adapter);
  // Check all declarations under strict, and application contracts under exactOptional.
  // AI SDK's own declarations fail exactOptional independently; use CHECK_AI_DECLARATIONS to reproduce.
  run('pnpm', [...flags, '--exactOptionalPropertyTypes', '--skipLibCheck'], adapter);
  await writeFile(join(consumer, 'loop.mjs'), await readFile(join(adapter, 'scripts/packed-loop.mjs')));
  run(process.execPath, ['./loop.mjs'], consumer, { ...process.env, AI_SDK_VERSION: ai });
}

async function verifyUpstreamDeclarations() {
  await writeFile(join(consumer, 'ai-only.ts'), "import { tool } from 'ai'; void tool;\n");
  const flags = ['exec', 'tsc', '--noEmit', '--strict', '--module', 'NodeNext',
    '--target', 'ES2022', '--lib', 'ES2022,DOM', join(consumer, 'ai-only.ts')];
  run('pnpm', flags, adapter);
  run('pnpm', [...flags, '--exactOptionalPropertyTypes'], adapter);
}

try {
  const archive = await pack(adapter);
  const sdkArchive = await pack(sdk);
  await unpack(archive);
  await verifyRoot();
  await install(archive, sdkArchive);
  await verifyTools();
  if (process.env.CHECK_AI_DECLARATIONS === '1') await verifyUpstreamDeclarations();
  console.log(`Packed ai@${ai} + zod@${zod}: strict declarations, exactOptional consumer with skipLibCheck, generated and streamed tools, and import boundaries passed.`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
