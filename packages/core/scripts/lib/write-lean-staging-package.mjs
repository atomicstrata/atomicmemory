/**
 * Lean Deno-compile staging helpers.
 *
 * Writes a production package.json without the local-transformers and
 * Filecoin/viem stacks, pins kept dependencies to `pnpm list` lock
 * versions, and verifies the hoisted install against those versions.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Packages dropped from the lean binary profile. */
export const LEAN_DROP_DEPENDENCIES = Object.freeze([
  '@huggingface/transformers',
  '@filoz/synapse-core',
  '@filoz/synapse-sdk',
  'viem',
  'multiformats',
  'tsx',
]);

const dropSet = new Set(LEAN_DROP_DEPENDENCIES);

/**
 * Filters a dependency map to the lean runtime set.
 *
 * @param {Record<string, string>} dependencies
 * @returns {Record<string, string>}
 */
export function filterLeanDependencies(dependencies) {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => !dropSet.has(name)),
  );
}

/**
 * Builds the lean package.json object from a full Core manifest.
 *
 * @param {{ name: string, version: string, dependencies?: Record<string, string> }} src
 */
export function buildLeanPackage(src) {
  return {
    name: src.name,
    version: src.version,
    type: 'module',
    main: './dist/index.js',
    bin: { 'atomicmemory-core': './dist/bin.js' },
    dependencies: filterLeanDependencies(src.dependencies ?? {}),
  };
}

/**
 * Rewrites the deployed package.json and deletes dropped node_modules trees.
 *
 * @param {string} stagingDir
 */
export function pruneDeployedTree(stagingDir) {
  const pkgPath = join(stagingDir, 'package.json');
  const src = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const lean = buildLeanPackage(src);
  writeFileSync(pkgPath, `${JSON.stringify(lean, null, 2)}\n`);
  for (const name of LEAN_DROP_DEPENDENCIES) {
    rmSync(join(stagingDir, 'node_modules', name), { recursive: true, force: true });
  }
  return lean;
}

/**
 * Reads `pnpm list --json --depth 0` output into a name → version map.
 *
 * @param {unknown} listJson
 * @returns {Record<string, string>}
 */
export function lockVersionsFromPnpmList(listJson) {
  const root = Array.isArray(listJson) ? listJson[0] : listJson;
  if (!root || typeof root !== 'object') {
    throw new Error('pnpm list JSON did not contain a package object');
  }
  const deps = /** @type {{ dependencies?: Record<string, { version?: string } | string> }} */ (
    root
  ).dependencies ?? {};
  /** @type {Record<string, string>} */
  const versions = {};
  for (const [name, info] of Object.entries(deps)) {
    const version = typeof info === 'string' ? info : info?.version;
    if (typeof version === 'string' && version.length > 0) {
      versions[name] = normalizeListedVersion(version);
    }
  }
  return versions;
}

/**
 * Pins lean dependencies to exact lockfile versions.
 *
 * @param {{ dependencies?: Record<string, string> }} pkg
 * @param {Record<string, string>} versions
 */
export function pinExactVersions(pkg, versions) {
  const dependencies = { ...pkg.dependencies };
  for (const name of Object.keys(dependencies)) {
    const version = versions[name];
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`lean staging: missing lockfile version for ${name}`);
    }
    dependencies[name] = version;
  }
  return { ...pkg, dependencies };
}

/**
 * @param {string} srcPath
 * @param {string} lockJsonPath
 * @param {string} destPath
 */
export function writePinnedLeanPackageFile(srcPath, lockJsonPath, destPath) {
  const src = JSON.parse(readFileSync(srcPath, 'utf8'));
  const listJson = JSON.parse(readFileSync(lockJsonPath, 'utf8'));
  const lean = pinExactVersions(buildLeanPackage(src), lockVersionsFromPnpmList(listJson));
  writeFileSync(destPath, `${JSON.stringify(lean, null, 2)}\n`);
  return lean;
}

/**
 * pnpm list may append peer suffixes such as `1.2.3(zod@4.0.0)`.
 *
 * @param {string} version
 */
function normalizeListedVersion(version) {
  const paren = version.indexOf('(');
  return paren === -1 ? version : version.slice(0, paren);
}

/**
 * Fails if a kept staging dependency does not match the lockfile version.
 *
 * @param {string} stagingDir
 * @param {Record<string, string>} lockVersions
 */
export function verifyStagingVersions(stagingDir, lockVersions) {
  const pkg = JSON.parse(readFileSync(join(stagingDir, 'package.json'), 'utf8'));
  const dependencies = pkg.dependencies ?? {};
  for (const name of Object.keys(dependencies)) {
    const installed = readInstalledVersion(stagingDir, name);
    const expected = lockVersions[name];
    if (!expected) {
      throw new Error(`lean staging: ${name} is not in the pnpm lock resolution set`);
    }
    if (installed !== expected) {
      throw new Error(`lean staging: ${name} is ${installed}, lockfile has ${expected}`);
    }
  }
}

/**
 * @param {string} stagingDir
 * @param {string} name
 */
function readInstalledVersion(stagingDir, name) {
  const installedPath = join(stagingDir, 'node_modules', name, 'package.json');
  try {
    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    if (typeof installed.version === 'string') {
      return installed.version;
    }
  } catch {
    throw new Error(`lean staging: missing installed package ${name}`);
  }
  throw new Error(`lean staging: ${name} has no version`);
}

/**
 * @param {string} stagingDir
 * @param {string} destPath
 */
export function writeLeanPackageFile(srcPath, destPath) {
  const src = JSON.parse(readFileSync(srcPath, 'utf8'));
  const lean = buildLeanPackage(src);
  writeFileSync(destPath, `${JSON.stringify(lean, null, 2)}\n`);
  return lean;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'write') {
    const [srcPath, destPath] = rest;
    const lean = writeLeanPackageFile(srcPath, destPath);
    process.stdout.write(`lean deps: ${Object.keys(lean.dependencies).sort().join(', ')}\n`);
    return;
  }
  if (command === 'write-pinned') {
    const [srcPath, lockJsonPath, destPath] = rest;
    const lean = writePinnedLeanPackageFile(srcPath, lockJsonPath, destPath);
    process.stdout.write(`lean pinned deps: ${Object.keys(lean.dependencies).sort().join(', ')}\n`);
    return;
  }
  if (command === 'prune') {
    pruneDeployedTree(rest[0]);
    return;
  }
  if (command === 'verify') {
    const [stagingDir, lockJsonPath] = rest;
    const listJson = JSON.parse(readFileSync(lockJsonPath, 'utf8'));
    verifyStagingVersions(stagingDir, lockVersionsFromPnpmList(listJson));
    return;
  }
  throw new Error('usage: write-lean-staging-package.mjs write|write-pinned|prune|verify ...');
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2));
}
