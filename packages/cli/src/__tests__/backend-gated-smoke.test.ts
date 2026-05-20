/**
 * @file Backend-gated smoke tests. Exercises full CLI subprocess
 * workflows against a real atomicmemory-core instance started by the
 * developer or CI job. Skipped by default so normal tests do not require
 * network access; opt in with:
 *
 *   ATOMICMEMORY_TEST_BACKEND=1 \
 *     ATOMICMEMORY_TEST_API_URL=http://127.0.0.1:17350 \
 *     pnpm test:backend
 *
 * These tests verify semantic outcomes, not just exit codes: persisted
 * IDs are listed, searchable, packaged, isolated by profile, and deleted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');
const binPath = resolve(cliRoot, 'dist', 'bin.js');

const skipIfDisabled =
  process.env.ATOMICMEMORY_TEST_BACKEND !== '1' || !existsSync(binPath);
const apiUrl = process.env.ATOMICMEMORY_TEST_API_URL ?? 'http://127.0.0.1:17350';

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface Fixture {
  tmp: string;
  configFile: string;
  runId: string;
}

interface SearchHit {
  memory: { id: string; content: string };
}

function runBin(args: readonly string[], configFile?: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (configFile) env.ATOMICMEMORY_CONFIG = configFile;
  const r = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

function fixture(prefix: string): Fixture {
  return {
    tmp: mkdtempSync(join(tmpdir(), `atomicmem-${prefix}-`)),
    configFile: '',
    runId: randomUUID(),
  };
}

function withConfig(f: Fixture): Fixture {
  return { ...f, configFile: join(f.tmp, 'config.json') };
}

function parseAgent<T>(result: RunResult): T {
  return JSON.parse(result.stdout.trim()) as T;
}

function assertOk(result: RunResult, label: string): void {
  assert.equal(result.code, 0, `${label} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}

function initProfile(configFile: string, profile: string, user: string): void {
  const init = runBin([
    '--agent',
    'init',
    '--profile',
    profile,
    '--provider',
    'atomicmemory',
    '--api-url',
    apiUrl,
    '--trust-surface',
    'local',
    '--user',
    user,
  ], configFile);
  assertOk(init, `init ${profile}`);
}

function addMemory(configFile: string, text: string, label: string): string {
  const result = runBin(['--agent', 'add', text], configFile);
  assertOk(result, label);
  const env = parseAgent<{ data: { created: string[]; updated: string[]; unchanged: string[] } }>(
    result,
  );
  const id = [...env.data.created, ...env.data.updated, ...env.data.unchanged][0];
  assert.ok(typeof id === 'string' && id.length > 0, `${label} did not return an id`);
  return id;
}

function deleteIfPresent(configFile: string, id: string | undefined): void {
  if (!id) return;
  runBin(['--agent', 'delete', id], configFile);
}

function search(configFile: string, query: string, limit = '10'): SearchHit[] {
  const result = runBin(['--agent', 'search', query, '--limit', limit], configFile);
  assertOk(result, `search ${query}`);
  return parseAgent<{ data: SearchHit[] }>(result).data;
}

function assertSearchFinds(configFile: string, query: string, id: string): void {
  assert.ok(
    search(configFile, query).some((hit) => hit.memory.id === id),
    `search did not return expected memory id ${id}`,
  );
}

/**
 * Resolve the id of an imported memory by searching for its embedded
 * marker substring and returning the first hit whose id is in the
 * caller-supplied imported-id set AND whose content actually contains
 * the marker. The `import` wire envelope concatenates per-record
 * outcomes across `created`/`updated`/`unchanged` buckets, so we
 * cannot rely on the returned id ARRAY ORDER matching the source-file
 * record order — that mapping has to come from the data itself.
 */
function findImportedIdByMarker(
  configFile: string,
  marker: string,
  imported: ReadonlySet<string>,
): string {
  const hits = search(configFile, marker);
  const match = hits.find(
    (hit) => imported.has(hit.memory.id) && hit.memory.content.includes(marker),
  );
  assert.ok(
    match,
    `search for "${marker}" returned no imported hit whose content contains the marker`,
  );
  return match!.memory.id;
}

function assertDoctorOnline(configFile: string): void {
  const doctor = runBin(['--agent', 'doctor'], configFile);
  assertOk(doctor, 'doctor online');
  const env = parseAgent<{ data: { ok: boolean; checks: Array<{ id: string; ok: boolean }> } }>(
    doctor,
  );
  assert.equal(env.data.ok, true);
  assert.ok(env.data.checks.some((c) => c.id === 'provider.connectivity' && c.ok === true));
}

function assertDoctorOffline(configFile: string): void {
  const doctor = runBin(['--agent', 'doctor', '--offline'], configFile);
  assertOk(doctor, 'doctor offline');
  const env = parseAgent<{ data: { ok: boolean; checks: Array<{ id: string; ok: boolean }> } }>(
    doctor,
  );
  assert.equal(env.data.ok, true);
  assert.ok(env.data.checks.some((c) => c.id === 'active_profile.present' && c.ok === true));
}

function assertListIncludes(configFile: string, id: string): void {
  const list = runBin(['--agent', 'list', '--limit', '20'], configFile);
  assertOk(list, 'list after add');
  const env = parseAgent<{ data: { memories: Array<{ id: string }> } }>(list);
  assert.ok(env.data.memories.some((memory) => memory.id === id), `list did not include ${id}`);
}

function assertGetReturns(configFile: string, id: string, marker: string): void {
  const get = runBin(['--agent', 'get', id], configFile);
  assertOk(get, 'get');
  const env = parseAgent<{ data: { id: string; content: string } }>(get);
  assert.equal(env.data.id, id);
  assert.ok(env.data.content.includes(marker));
}

function assertDeleted(configFile: string, id: string): void {
  const del = runBin(['--agent', 'delete', id], configFile);
  assertOk(del, 'delete');
  const followup = runBin(['--agent', 'get', id], configFile);
  assert.equal(followup.code, 4, `expected not_found exit 4; got ${followup.code}`);
}

function assertPackageIncludes(configFile: string, query: string, id: string): void {
  const pkg = runBin(packageArgs(query), configFile);
  assertOk(pkg, 'package');
  const env = parsePackage(pkg);
  assert.equal(env.meta.budget_constrained, env.data.budgetConstrained);
  assert.equal(env.meta.token_budget, 500);
  assert.equal(env.meta.format, 'tiered');
  assert.equal(env.meta.section, 'inline');
  assert.ok(env.data.tokens >= 0);
  assert.ok(env.data.hits.some((hit) => hit.memory.id === id) || env.data.text.includes(query));
}

function packageArgs(query: string): string[] {
  return [
    '--agent',
    'package',
    query,
    '--format',
    'tiered',
    '--token-budget',
    '500',
    '--section',
    'inline',
  ];
}

function parsePackage(result: RunResult): {
  meta: { budget_constrained: boolean; token_budget: number; format: string; section: string };
  data: { text: string; tokens: number; hits: SearchHit[]; budgetConstrained: boolean };
} {
  return parseAgent(result);
}

function ingestVerbatim(configFile: string, text: string): string {
  const result = runBin([
    '--agent',
    'ingest',
    '--mode',
    'verbatim',
    '--kind',
    'fact',
    text,
  ], configFile);
  assertOk(result, 'ingest verbatim');
  return parseAgent<{ data: { created: string[] } }>(result).data.created[0]!;
}

function importRecords(configFile: string, file: string): string[] {
  const result = runBin(['--agent', 'import', file], configFile);
  assertOk(result, 'import');
  const env = parseAgent<{
    data: { created: string[]; updated: string[]; unchanged: string[] };
    meta: { records: number };
  }>(result);
  assert.equal(env.meta.records, 2);
  const ids = [...env.data.created, ...env.data.updated, ...env.data.unchanged];
  assert.equal(ids.length, 2);
  return ids;
}

function switchProfile(configFile: string, profile: string): void {
  const result = runBin(['--agent', 'config', 'profile', 'use', profile], configFile);
  assertOk(result, `profile use ${profile}`);
  assert.equal(parseAgent<{ data: { active: string } }>(result).data.active, profile);
}

function switchProfileIfPresent(configFile: string, profile: string): void {
  runBin(['--agent', 'config', 'profile', 'use', profile], configFile);
}

function assertProfiles(configFile: string): void {
  const result = runBin(['--agent', 'config', 'profile', 'list'], configFile);
  assertOk(result, 'profile list');
  const env = parseAgent<{ data: { active: string; profiles: string[] } }>(result);
  assert.equal(env.data.active, 'alpha');
  assert.deepEqual(env.data.profiles, ['alpha', 'beta']);
}

test('backend smoke: init -> doctor -> add -> search -> get -> delete', {
  skip: skipIfDisabled,
}, async () => {
  const f = withConfig(fixture('backend-smoke'));
  const marker = `phase8-smoke-${f.runId}`;
  const text = `During backend smoke test ${marker}, Alice recorded that the smoke deletion check codename is ${marker}.`;
  try {
    initProfile(f.configFile, 'default', `smoke-${f.runId}`);
    assertDoctorOffline(f.configFile);
    const id = addMemory(f.configFile, text, 'add smoke');
    assertSearchFinds(f.configFile, marker, id);
    assertGetReturns(f.configFile, id, marker);
    assertDeleted(f.configFile, id);
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('backend smoke: doctor online, package, and list use backend metadata', {
  skip: skipIfDisabled,
}, async () => {
  const f = withConfig(fixture('backend-package'));
  const sentinel = `package-live-${f.runId}`;
  let id: string | undefined;
  try {
    initProfile(f.configFile, 'default', `package-${f.runId}`);
    assertDoctorOnline(f.configFile);
    id = addMemory(
      f.configFile,
      `During backend package test ${sentinel}, Alice recorded that the durable package context codename is ${sentinel}.`,
      'add package',
    );
    assertListIncludes(f.configFile, id);
    assertPackageIncludes(f.configFile, sentinel, id);
  } finally {
    deleteIfPresent(f.configFile, id);
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('backend smoke: ingest and import persist searchable memories', {
  skip: skipIfDisabled,
}, async () => {
  const f = withConfig(fixture('backend-ingest'));
  const importFile = join(f.tmp, 'import.json');
  const ids: string[] = [];
  try {
    initProfile(f.configFile, 'default', `ingest-${f.runId}`);
    const verbatim = `verbatim-live-${f.runId}`;
    ids.push(ingestVerbatim(f.configFile, `${verbatim} explicit verbatim fact`));
    assertSearchFinds(f.configFile, verbatim, ids[0]!);
    writeImportFile(importFile, f.runId);
    const importedIds = importRecords(f.configFile, importFile);
    ids.push(...importedIds);
    // Resolve marker → id by searching, NOT by index. The `import`
    // envelope concatenates created/updated/unchanged so input order
    // does not survive the round trip when records split across buckets.
    const importedIdSet = new Set(importedIds);
    const idA = findImportedIdByMarker(
      f.configFile,
      `import-live-a-${f.runId}`,
      importedIdSet,
    );
    const idB = findImportedIdByMarker(
      f.configFile,
      `import-live-b-${f.runId}`,
      importedIdSet,
    );
    assert.notEqual(idA, idB, 'imported A and B must map to distinct ids');
  } finally {
    for (const id of ids) deleteIfPresent(f.configFile, id);
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

function writeImportFile(file: string, runId: string): void {
  writeFileSync(file, JSON.stringify([
    {
      text: `During backend import test import-live-a-${runId}, Alice recorded that the first imported codename is import-live-a-${runId}.`,
      metadata: { source: 'cli-backend-smoke' },
    },
    {
      content: `During backend import test import-live-b-${runId}, Bob recorded that the second imported codename is import-live-b-${runId}.`,
      provenance: { source: 'backend-smoke' },
    },
  ]));
}

test('backend smoke: named profiles isolate users and active profile switching', {
  skip: skipIfDisabled,
}, async () => {
  const f = withConfig(fixture('backend-profiles'));
  let idA: string | undefined;
  let idB: string | undefined;
  try {
    initProfile(f.configFile, 'alpha', `profile-a-${f.runId}`);
    initProfile(f.configFile, 'beta', `profile-b-${f.runId}`);
    assertProfiles(f.configFile);
    idA = addMemory(
      f.configFile,
      `During backend profile test alpha-only-${f.runId}, Alice recorded that the alpha-only codename is alpha-only-${f.runId}.`,
      'add alpha',
    );
    switchProfile(f.configFile, 'beta');
    idB = addMemory(
      f.configFile,
      `During backend profile test beta-only-${f.runId}, Bob recorded that the beta-only codename is beta-only-${f.runId}.`,
      'add beta',
    );
    assertProfileSearchIsolation(f.configFile, f.runId, idA, idB);
  } finally {
    switchProfileIfPresent(f.configFile, 'alpha');
    deleteIfPresent(f.configFile, idA);
    switchProfileIfPresent(f.configFile, 'beta');
    deleteIfPresent(f.configFile, idB);
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

function assertProfileSearchIsolation(
  configFile: string,
  runId: string,
  idA: string,
  idB: string,
): void {
  assertSearchFinds(configFile, `beta-only-${runId}`, idB);
  assert.equal(search(configFile, `alpha-only-${runId}`).some((hit) => hit.memory.id === idA), false);
  switchProfile(configFile, 'alpha');
  assertSearchFinds(configFile, `alpha-only-${runId}`, idA);
}
