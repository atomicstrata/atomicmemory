#!/usr/bin/env node
/**
 * sync-versions.mjs
 *
 * Verifies (or, with no flags, fixes) that the version stamped in `package.json`
 * matches the `package_version` field in `cli-spec.json`. Future phases will
 * extend this to also check embedded SKILL.md metadata and config-schema
 * metadata once those artifacts move to build-time embedding.
 *
 * Usage:
 *   node scripts/sync-versions.mjs           # write the package.json version into cli-spec.json
 *   node scripts/sync-versions.mjs --check   # exit 1 if they disagree (CI mode)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkgPath = resolve(root, 'package.json');
const specPath = resolve(root, 'cli-spec.json');

const checkOnly = process.argv.includes('--check');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

const pkgVersion = pkg.version;
const specVersion = spec.package_version;

if (typeof pkgVersion !== 'string' || pkgVersion.length === 0) {
  console.error('package.json: missing or invalid "version"');
  process.exit(1);
}
if (typeof specVersion !== 'string' || specVersion.length === 0) {
  console.error('cli-spec.json: missing or invalid "package_version"');
  process.exit(1);
}

if (pkgVersion === specVersion) {
  console.log(`OK package.json and cli-spec.json both report ${pkgVersion}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `version drift: package.json=${pkgVersion} cli-spec.json=${specVersion}`,
  );
  console.error('run `pnpm -C packages/cli sync-versions` to fix.');
  process.exit(1);
}

spec.package_version = pkgVersion;
writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
console.log(`updated cli-spec.json package_version: ${specVersion} -> ${pkgVersion}`);
