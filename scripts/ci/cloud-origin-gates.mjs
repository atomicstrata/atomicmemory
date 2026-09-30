#!/usr/bin/env node
/**
 * Verify every replicated Cloud credential gate tracks the CLI's canonical
 * first-party host list and has behavioral coverage for each host.
 *
 * Each implementation's host set is read from its actual set literal, with
 * comments stripped, and must equal the canonical CLI set exactly. A host
 * that survives only in a comment, a DEFAULT_*_URL constant, or an error
 * message does not count, and a missing or extra host fails.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLOUD_ERROR_MARKER = 'AtomicMemory Cloud';
const CANONICAL_SOURCE = 'crates/cli/src/environment.rs';
const SOURCE_ROOTS = ['packages/mcp-server/src', 'plugins/claude-code/scripts', 'plugins/hermes', 'plugins/openclaw/src'];
const HOST_INVENTORIES = new Map([
  ['plugins/openclaw/skills/atomicmemory/skill.yaml', 'plugins/openclaw/src/index.test.ts'],
]);

/**
 * Credential gate source -> its behavioral test and the extractor that reads
 * the gate's actual host set literal.
 */
export const GATES = new Map([
  ['packages/mcp-server/src/config.ts', { test: 'packages/mcp-server/src/config.test.ts', extract: extractTsHostSet }],
  [
    'plugins/claude-code/scripts/lib/atomicmemory.sh',
    { test: 'plugins/claude-code/scripts/__tests__/load-env-defaults.sh', extract: extractBashHostSet },
  ],
  ['plugins/hermes/python_sdk.py', { test: 'plugins/hermes/tests/test_python_sdk.py', extract: extractPythonHostSet }],
  ['plugins/openclaw/src/index.ts', { test: 'plugins/openclaw/src/index.test.ts', extract: extractTsHostSet }],
]);

// Strings are matched first so comment markers inside them (for example the
// `//` in a URL) are preserved; everything else matched is a comment.
const C_STYLE_COMMENTS =
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const HASH_COMMENTS = /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(?<=^|[ \t])#[^\n]*/gm;

function stripComments(source, pattern) {
  return source.replace(pattern, (match, literal) => literal ?? '');
}

function quotedStrings(text) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2]);
}

function requireMatch(match, label, what) {
  if (!match) throw new Error(`${label}: could not find ${what}`);
  return match;
}

/** Rust: `FIRST_PARTY_API_HOSTS: [&str; N] = [ ... ];` */
export function extractRustHostSet(source, label = CANONICAL_SOURCE) {
  const code = stripComments(source, C_STYLE_COMMENTS);
  const match = requireMatch(
    code.match(/\bFIRST_PARTY_API_HOSTS\s*:\s*\[[^\]]*\]\s*=\s*\[([^\]]*)\]/),
    label,
    'the FIRST_PARTY_API_HOSTS array literal',
  );
  return quotedStrings(match[1]);
}

/** TypeScript: `CLOUD_API_HOSTNAMES = new Set([ ... ])` */
export function extractTsHostSet(source, label) {
  const code = stripComments(source, C_STYLE_COMMENTS);
  const match = requireMatch(
    code.match(/\bCLOUD_API_HOSTNAMES\s*=\s*new Set\(\s*\[([^\]]*)\]\s*\)/),
    label,
    'the CLOUD_API_HOSTNAMES = new Set([...]) literal',
  );
  return quotedStrings(match[1]);
}

/** Python: `CLOUD_API_HOSTNAMES = frozenset({ ... })` */
export function extractPythonHostSet(source, label) {
  const code = stripComments(source, HASH_COMMENTS);
  const match = requireMatch(
    code.match(/^CLOUD_API_HOSTNAMES\s*=\s*frozenset\(\s*\{([^}]*)\}\s*\)/m),
    label,
    'the CLOUD_API_HOSTNAMES = frozenset({...}) literal',
  );
  return quotedStrings(match[1]);
}

/** Bash: the `return 0` case arm of `am_is_cloud_api_host`. */
export function extractBashHostSet(source, label) {
  const code = stripComments(source, HASH_COMMENTS);
  const body = requireMatch(
    code.match(/^am_is_cloud_api_host\(\)\s*\{\n([\s\S]*?)^\}/m),
    label,
    'the am_is_cloud_api_host function',
  )[1];
  const arms = [...body.matchAll(/^\s*([^\s()][^()\n]*)\)\s*return 0\s*;;/gm)];
  if (arms.length !== 1) throw new Error(`${label}: expected exactly one return-0 case arm in am_is_cloud_api_host`);
  const hosts = arms[0][1].split('|').map((pattern) => pattern.trim().replace(/^(["'])(.*)\1$/, '$2'));
  for (const host of hosts) {
    if (!/^[a-z0-9.-]+$/.test(host)) throw new Error(`${label}: case pattern ${JSON.stringify(host)} is not a literal hostname`);
  }
  return hosts;
}

function compareHostSets(label, actual, canonical) {
  const failures = [];
  const duplicates = actual.filter((host, index) => actual.indexOf(host) !== index);
  if (duplicates.length) failures.push(`${label} lists ${[...new Set(duplicates)].join(', ')} more than once`);
  for (const host of canonical) if (!actual.includes(host)) failures.push(`${label} omits ${host}`);
  for (const host of new Set(actual)) if (!canonical.includes(host)) failures.push(`${label} has extra host ${host}`);
  return failures;
}

function defaultRead(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sourceFiles(path) {
  const absolute = resolve(ROOT, path);
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute).flatMap((entry) => sourceFiles(`${path}/${entry}`));
}

function discoverCredentialGates(read, cloudHosts) {
  return SOURCE_ROOTS.flatMap(sourceFiles)
    .filter((path) => ['.ts', '.py', '.sh'].includes(extname(path)))
    .filter((path) => !path.includes('/tests/') && !path.includes('/__tests__/') && !path.endsWith('.test.ts'))
    .filter((path) => cloudHosts.some((hostname) => read(path).includes(hostname)))
    .sort();
}

/**
 * Return every alignment failure. `read(path)` returns a repo-relative file's
 * text, so tests can substitute mutated sources without touching disk.
 */
export function validateCloudOriginGates(read = defaultRead) {
  const failures = [];
  let canonical;
  try {
    canonical = extractRustHostSet(read(CANONICAL_SOURCE));
  } catch (error) {
    return [error.message];
  }
  if (canonical.length === 0) return [`${CANONICAL_SOURCE}: FIRST_PARTY_API_HOSTS is empty`];

  const expectedGates = [...GATES.keys()].sort();
  const discoveredGates = discoverCredentialGates(read, canonical);
  if (JSON.stringify(discoveredGates) !== JSON.stringify(expectedGates)) {
    failures.push(
      `credential gate inventory changed\nexpected: ${expectedGates.join(', ')}\nactual: ${discoveredGates.join(', ')}`,
    );
  }

  for (const [sourcePath, { test: testPath, extract }] of GATES) {
    const source = read(sourcePath);
    const test = read(testPath);
    if (!source.includes(CLOUD_ERROR_MARKER)) failures.push(`${sourcePath} does not enforce the Cloud key`);
    try {
      failures.push(...compareHostSets(sourcePath, extract(source, sourcePath), canonical));
    } catch (error) {
      failures.push(error.message);
    }
    for (const hostname of canonical) {
      if (!test.includes(hostname)) failures.push(`${testPath} does not test ${hostname}`);
    }
  }

  for (const [inventoryPath, testPath] of HOST_INVENTORIES) {
    const inventory = read(inventoryPath);
    const test = read(testPath);
    for (const hostname of canonical) {
      if (!inventory.includes(`https://${hostname}`)) failures.push(`${inventoryPath} omits https://${hostname}`);
      if (!test.includes(hostname)) failures.push(`${testPath} does not test permission for ${hostname}`);
    }
  }

  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = validateCloudOriginGates();
  for (const failure of failures) console.error(`Cloud origin gate validation failed: ${failure}`);
  if (failures.length) process.exitCode = 1;
  else console.log('Cloud origin credential gates are aligned.');
}
