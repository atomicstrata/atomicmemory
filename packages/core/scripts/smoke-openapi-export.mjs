#!/usr/bin/env node
/**
 * @file Consumer-resolution smoke check for the OpenAPI spec exports.
 *
 * Resolves `@atomicmemory/core/openapi.json` via
 * `createRequire` (core is "type": "module"; plain ESM JSON imports
 * without a `type: 'json'` attribute throw `ERR_IMPORT_ATTRIBUTE_MISSING`
 * on Node 22+).
 *
 * ⚠️ Resolve base: `createRequire(cwd/package.json)`, NOT
 * `import.meta.url`. If we used the script's own URL as the base,
 * Node would walk up from `scripts/` in the source checkout and
 * resolve back to the repo's own `openapi.json` — a false positive
 * for publish/export regressions. Using cwd forces resolution
 * through the scratch project's own `node_modules`.
 *
 * Run against a packed tarball in a scratch dir to catch exports-map
 * regressions before atomicmemory-docs picks up a broken publish:
 *
 *   npm pack
 *   mkdir -p /tmp/core-export-smoke && cd /tmp/core-export-smoke
 *   npm init -y
 *   npm install /path/to/atomicmemory-core-<version>.tgz
 *   node /path/to/scripts/smoke-openapi-export.mjs
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Anchor the resolution to cwd/package.json so `require(...)` walks
// through the scratch project's node_modules, not the source checkout's.
const require = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')));

let spec;
try {
  spec = require('@atomicmemory/core/openapi.json');
} catch (err) {
  console.error('FAIL: require("@atomicmemory/core/openapi.json") threw');
  console.error(err);
  process.exit(1);
}

if (!spec || typeof spec !== 'object') {
  console.error('FAIL: spec is not an object:', spec);
  process.exit(1);
}

const requiredFields = ['openapi', 'info', 'paths'];
for (const field of requiredFields) {
  if (!(field in spec)) {
    console.error(`FAIL: spec is missing required field "${field}"`);
    process.exit(1);
  }
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace']);
let operationCount = 0;
for (const methods of Object.values(spec.paths)) {
  if (methods && typeof methods === 'object') {
    for (const key of Object.keys(methods)) {
      if (HTTP_METHODS.has(key)) operationCount++;
    }
  }
}

if (operationCount < 29) {
  console.error(`FAIL: expected at least 29 operations (24 memory + 5 agents routes), got ${operationCount}`);
  process.exit(1);
}

console.log(
  `ok: openapi ${spec.openapi} / ${spec.info?.title ?? 'untitled'} v${spec.info?.version ?? '?'} / ${Object.keys(spec.paths).length} paths / ${operationCount} operations`,
);
