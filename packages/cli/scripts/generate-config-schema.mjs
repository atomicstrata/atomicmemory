#!/usr/bin/env node
/**
 * generate-config-schema.mjs
 *
 * Generates `config.schema.json` from the runtime zod config model in
 * `src/config/schema.ts`. The runtime model is the single source of truth.
 *
 * Until Phase 3 lands `src/config/schema.ts`, this script exits 0 in --check
 * mode (with a clear message) so CI does not block the foundation work that
 * has to ship first.
 *
 * Invocation: must run through `node --import tsx` (wired in package.json
 * scripts as `generate-config-schema` / `generate-config-schema:check`) so
 * the dynamic `import(modelPath)` of a `.ts` source resolves on Node 20.
 * Running plain `node scripts/generate-config-schema.mjs` will error out
 * with "Unknown file extension" once `src/config/schema.ts` exists.
 *
 * Usage:
 *   pnpm -C packages/cli generate-config-schema           # write config.schema.json from the zod model
 *   pnpm -C packages/cli generate-config-schema:check     # exit 1 if regeneration would change the file
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const schemaPath = resolve(root, 'config.schema.json');
const modelPath = resolve(root, 'src/config/schema.ts');

const checkOnly = process.argv.includes('--check');

if (!existsSync(modelPath)) {
  const msg = `runtime config model not yet present at ${modelPath} (Phase 3). Skipping.`;
  console.log(msg);
  process.exit(0);
}

// Phase 3+ behavior. Lazy-import so this script can run before zod is installed
// during early Phase 0 setup.
const [{ zodToJsonSchema }, modelModule] = await Promise.all([
  import('zod-to-json-schema'),
  import(modelPath),
]);

const cliConfigSchema = modelModule.CliConfigSchema;
if (!cliConfigSchema) {
  console.error(
    `expected ${modelPath} to export "CliConfigSchema" (a zod schema). Got: ${Object.keys(modelModule).join(', ') || '(none)'}`,
  );
  process.exit(1);
}

const generated = zodToJsonSchema(cliConfigSchema, {
  $refStrategy: 'none',
  target: 'jsonSchema2019-09',
});
generated.$schema = 'https://json-schema.org/draft/2020-12/schema';
generated.$id = 'https://schemas.atomicmemory.ai/cli/config.schema.json';

const generatedText = JSON.stringify(generated, null, 2) + '\n';

if (checkOnly) {
  if (!existsSync(schemaPath)) {
    console.error(`config.schema.json missing at ${schemaPath}`);
    process.exit(1);
  }
  const onDisk = readFileSync(schemaPath, 'utf8');
  if (onDisk === generatedText) {
    console.log('OK config.schema.json matches the runtime zod model.');
    process.exit(0);
  }
  console.error(
    'config.schema.json drift: regeneration would change the file.',
  );
  console.error('run `pnpm -C packages/cli generate-config-schema` to fix.');
  process.exit(1);
}

writeFileSync(schemaPath, generatedText);
console.log(`wrote ${schemaPath}`);
