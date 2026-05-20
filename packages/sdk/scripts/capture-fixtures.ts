/**
 * @file Capture real `atomicmemory-core` HTTP responses into static
 * fixtures the mapper replay tests run against in CI.
 *
 * Execution order matters and follows the plan: clean-checkout guard
 * BEFORE any HTTP I/O or fixture writes; LLM-access probe before the
 * real capture sequence; normalization in a single recursive walk
 * before either raw.json or mapped.json is written so the pair stays
 * aligned.
 *
 * This script is run manually by maintainers via `pnpm fixtures:capture`.
 * It never runs in CI — CI consumes the committed fixture files.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toIngestResult, toMemory, toSearchResult } from '../src/memory/atomicmemory-provider/mappers';
import type { Scope } from '../src/memory/types';

import {
  FULL_INGEST_PAYLOAD,
  QUICK_INGEST_PAYLOAD,
  SEARCH_PAYLOAD,
} from './capture-fixtures-input';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const CORE_REPO = resolve(SDK_ROOT, '..', 'core');
const FIXTURES_DIR = resolve(
  SDK_ROOT,
  'src/memory/atomicmemory-provider/__tests__/fixtures',
);

const DEFAULT_CORE_URL = 'http://localhost:17350';
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;

/** Canonical user_id written into committed fixtures (after normalization). */
const CANONICAL_USER_ID = 'fixture-capture';
/** Throwaway user for the LLM probe — never written to a fixture. */
const PROBE_USER_ID = 'fixture-capture-llm-probe';

/** Fixed ISO timestamp every `*_at` field is normalized to. */
const FIXED_TIMESTAMP = '2026-04-24T10:00:00.000Z';

const COUNTER_FIELDS = new Set([
  'access_count',
  'version',
  'episode_index',
]);

// ---------------------------------------------------------------------------
// Step (1): clean-checkout guard
// ---------------------------------------------------------------------------

interface CoreVersionInfo {
  sha: string;
  branch: string;
  dirty: boolean;
  dirtyOverride: boolean;
}

function cleanCheckoutGuard(): CoreVersionInfo {
  if (!existsSync(CORE_REPO)) {
    throw new Error(
      `Core package not found at ${CORE_REPO}. ` +
      `Capture requires packages/core next to packages/sdk.`,
    );
  }

  const status = gitOutput(['-C', CORE_REPO, 'status', '--porcelain']).trim();
  const dirty = status !== '';
  const dirtyOverride = process.env.ALLOW_DIRTY_CAPTURE === '1';

  if (dirty && !dirtyOverride) {
    throw new Error(
      'packages/core working tree is dirty:\n' +
      status.split('\n').slice(0, 10).map((l) => '  ' + l).join('\n') +
      (status.split('\n').length > 10 ? '\n  ...' : '') +
      '\n\nEither commit/stash those changes, or set ' +
      '`ALLOW_DIRTY_CAPTURE=1` to acknowledge that the captured ' +
      'fixtures are local-only and not reproducible from the SHA in ' +
      '_meta.json.',
    );
  }

  const sha = (process.env.CORE_VERSION ?? '').trim() ||
    safeGitOutput(['-C', CORE_REPO, 'rev-parse', 'HEAD']) ||
    'unknown';
  const branch = safeGitOutput(['-C', CORE_REPO, 'rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';

  return { sha: sha.trim(), branch: branch.trim(), dirty, dirtyOverride };
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function safeGitOutput(args: string[]): string | null {
  try {
    return gitOutput(args).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step (3): health poll
// ---------------------------------------------------------------------------

async function pollHealth(coreUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${coreUrl}/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `packages/core not reachable at ${coreUrl} after ${HEALTH_TIMEOUT_MS}ms. ` +
    `Last error: ${lastError}.\n` +
    `Bring it up with: cd ${CORE_REPO} && docker compose up -d --build`,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Step (4): LLM probe
// ---------------------------------------------------------------------------

async function llmProbe(coreUrl: string): Promise<void> {
  const probeBody = {
    user_id: PROBE_USER_ID,
    conversation: 'user: probe.\nassistant: probe.',
    source_site: 'fixture-capture-probe',
  };
  const res = await fetch(`${coreUrl}/v1/memories/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(probeBody),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `Capture requires a working LLM on core. The probe ingest at ` +
      `POST /v1/memories/ingest failed with HTTP ${res.status}:\n${errBody.slice(0, 500)}\n\n` +
      `Either set OPENAI_API_KEY in packages/core/.env and ` +
      `\`docker compose up -d\`, or switch core to LLM_PROVIDER=ollama ` +
      `with a reachable ollama server.`,
    );
  }
  // Probe response is discarded; no fixture is written from it.
}

// ---------------------------------------------------------------------------
// Step (6): the five capture requests
// ---------------------------------------------------------------------------

interface CapturedResponses {
  ingest: unknown;
  ingestQuick: unknown;
  search: unknown;
  searchFast: unknown;
  list: unknown;
}

async function captureAll(coreUrl: string, runUserId: string): Promise<CapturedResponses> {
  const ingest = await postJson(coreUrl, '/v1/memories/ingest', {
    user_id: runUserId,
    conversation: FULL_INGEST_PAYLOAD.conversation,
    source_site: FULL_INGEST_PAYLOAD.source_site,
    source_url: FULL_INGEST_PAYLOAD.source_url,
  });
  const ingestQuick = await postJson(coreUrl, '/v1/memories/ingest/quick', {
    user_id: runUserId,
    conversation: QUICK_INGEST_PAYLOAD.conversation,
    source_site: QUICK_INGEST_PAYLOAD.source_site,
    source_url: QUICK_INGEST_PAYLOAD.source_url,
  });
  const search = await postJson(coreUrl, '/v1/memories/search', {
    user_id: runUserId,
    query: SEARCH_PAYLOAD.query,
    limit: SEARCH_PAYLOAD.limit,
  });
  const searchFast = await postJson(coreUrl, '/v1/memories/search/fast', {
    user_id: runUserId,
    query: SEARCH_PAYLOAD.query,
    limit: SEARCH_PAYLOAD.limit,
  });
  const list = await getJson(coreUrl, `/v1/memories/list?user_id=${encodeURIComponent(runUserId)}`);
  return { ingest, ingestQuick, search, searchFast, list };
}

async function postJson(coreUrl: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${coreUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`POST ${path} failed: HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function getJson(coreUrl: string, path: string): Promise<unknown> {
  const res = await fetch(`${coreUrl}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`GET ${path} failed: HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Step (7): normalization (deep walk)
// ---------------------------------------------------------------------------

interface Normalizer {
  runUserId: string;
  memoryIds: Map<string, string>;
  episodeIds: Map<string, string>;
  cmoIds: Map<string, string>;
}

function makeNormalizer(runUserId: string): Normalizer {
  return {
    runUserId,
    memoryIds: new Map(),
    episodeIds: new Map(),
    cmoIds: new Map(),
  };
}

function normalize<T>(value: T, n: Normalizer): T {
  return walk(value, n) as T;
}

function walk(value: unknown, n: Normalizer): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, n));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeField(k, v, n);
    }
    return out;
  }
  return value;
}

// Field names whose array contents are memory-ID strings.
// Search responses surface memory IDs in several places besides the
// memory rows themselves — citations, observability.packaging.included_ids,
// observability.packaging.dropped_ids, observability.assembly.final_ids,
// plus the ingest result's stored/updated IDs. All of these go through
// the same memoryIds canonical table so the same UUID maps to the same
// FIXTURE-MEM-N across the whole fixture set.
const MEMORY_ID_ARRAY_FIELDS = new Set([
  'stored_memory_ids',
  'updated_memory_ids',
  'citations',
  'included_ids',
  'dropped_ids',
  'final_ids',
]);

// Fields whose value is an object keyed by memory ID (e.g.
// observability.packaging.evidence_roles: { <memId>: 'primary' }).
const MEMORY_ID_KEYED_OBJECT_FIELDS = new Set([
  'evidence_roles',
]);

function normalizeField(key: string, value: unknown, n: Normalizer): unknown {
  if (key === 'user_id' && value === n.runUserId) return CANONICAL_USER_ID;
  if (key.endsWith('_at') && typeof value === 'string') return FIXED_TIMESTAMP;
  if (COUNTER_FIELDS.has(key) && typeof value === 'number') return 0;
  if (key === 'id' && typeof value === 'string') {
    return canonicalize(value, 'FIXTURE-MEM', n.memoryIds);
  }
  if ((key === 'episode_id' || key === 'episodeId') && typeof value === 'string') {
    return canonicalize(value, 'FIXTURE-EP', n.episodeIds);
  }
  if (key === 'cmo_id' && typeof value === 'string') {
    return canonicalize(value, 'FIXTURE-CMO', n.cmoIds);
  }
  if (MEMORY_ID_ARRAY_FIELDS.has(key) && Array.isArray(value)) {
    return value.map((id) =>
      typeof id === 'string' ? canonicalize(id, 'FIXTURE-MEM', n.memoryIds) : id,
    );
  }
  if (MEMORY_ID_KEYED_OBJECT_FIELDS.has(key) && value && typeof value === 'object') {
    return rekeyByMemoryId(value as Record<string, unknown>, n);
  }
  // Embeddings: huge non-deterministic float arrays. Replace with an
  // empty array so the mapper still sees the field but the fixture
  // file stays diff-reviewable.
  if (key === 'embedding' && Array.isArray(value)) return [];
  return walk(value, n);
}

function rekeyByMemoryId(
  obj: Record<string, unknown>,
  n: Normalizer,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const newKey = canonicalize(k, 'FIXTURE-MEM', n.memoryIds);
    out[newKey] = walk(v, n);
  }
  return out;
}

function canonicalize(value: string, prefix: string, table: Map<string, string>): string {
  const existing = table.get(value);
  if (existing) return existing;
  const next = `${prefix}-${table.size + 1}`;
  table.set(value, next);
  return next;
}

// ---------------------------------------------------------------------------
// Step (8): write fixtures
// ---------------------------------------------------------------------------

const SCOPE: Scope = { user: CANONICAL_USER_ID };

interface FixturePair {
  name: string;
  raw: unknown;
  mapped: unknown;
}

function buildFixturePairs(captured: CapturedResponses): FixturePair[] {
  return [
    { name: 'ingest', raw: captured.ingest, mapped: mapIngest(captured.ingest) },
    { name: 'ingest-quick', raw: captured.ingestQuick, mapped: mapIngest(captured.ingestQuick) },
    { name: 'search', raw: captured.search, mapped: mapSearch(captured.search) },
    { name: 'search-fast', raw: captured.searchFast, mapped: mapSearch(captured.searchFast) },
    { name: 'list', raw: captured.list, mapped: mapList(captured.list) },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapIngest(raw: any): unknown {
  return toIngestResult(raw);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSearch(raw: any): unknown {
  const memories = Array.isArray(raw?.memories) ? raw.memories : [];
  return memories.map((m: unknown) => toSearchResult(m as never, SCOPE));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapList(raw: any): unknown {
  const memories = Array.isArray(raw?.memories) ? raw.memories : [];
  return memories.map((m: unknown) => toMemory(m as never, SCOPE));
}

function writeFixtures(pairs: FixturePair[]): void {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const { name, raw, mapped } of pairs) {
    writeJson(join(FIXTURES_DIR, `${name}.raw.json`), raw);
    // JSON-roundtrip mapped output so Date instances become ISO strings.
    writeJson(join(FIXTURES_DIR, `${name}.mapped.json`), JSON.parse(JSON.stringify(mapped)));
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// _meta.json
// ---------------------------------------------------------------------------

interface HealthResponse {
  status: string;
  config?: Record<string, unknown>;
}

async function fetchProviderConfig(coreUrl: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`${coreUrl}/v1/memories/health`);
    if (!res.ok) return undefined;
    const body = await res.json() as HealthResponse;
    return body.config;
  } catch {
    return undefined;
  }
}

interface Meta {
  capturedAt: string;
  coreSha: string;
  coreBranch: string;
  dirty: boolean;
  dirtyOverride: boolean;
  providerConfig?: Record<string, unknown>;
}

function writeMeta(meta: Meta): void {
  writeJson(join(FIXTURES_DIR, '_meta.json'), meta);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Step (1) clean-checkout guard...');
  const versionInfo = cleanCheckoutGuard();
  console.log(`  core SHA: ${versionInfo.sha} (branch: ${versionInfo.branch}, dirty: ${versionInfo.dirty})`);

  const coreUrl = process.env.CORE_URL ?? DEFAULT_CORE_URL;
  console.log(`Step (2) CORE_URL = ${coreUrl}`);

  console.log('Step (3) health poll...');
  await pollHealth(coreUrl);

  console.log('Step (4) LLM probe...');
  await llmProbe(coreUrl);

  const runUserId = `${CANONICAL_USER_ID}-${Date.now()}`;
  console.log(`Step (5) runUserId = ${runUserId}`);

  console.log('Step (6) capturing 5 endpoints...');
  const captured = await captureAll(coreUrl, runUserId);

  console.log('Step (7) normalizing volatile fields...');
  const n = makeNormalizer(runUserId);
  const normalized: CapturedResponses = {
    ingest: normalize(captured.ingest, n),
    ingestQuick: normalize(captured.ingestQuick, n),
    search: normalize(captured.search, n),
    searchFast: normalize(captured.searchFast, n),
    list: normalize(captured.list, n),
  };

  console.log('Step (8) writing fixtures + _meta.json...');
  const pairs = buildFixturePairs(normalized);
  writeFixtures(pairs);

  const providerConfig = await fetchProviderConfig(coreUrl);
  writeMeta({
    capturedAt: new Date().toISOString(),
    coreSha: versionInfo.sha,
    coreBranch: versionInfo.branch,
    dirty: versionInfo.dirty,
    dirtyOverride: versionInfo.dirtyOverride,
    providerConfig,
  });

  console.log(`\nDone. Wrote ${pairs.length * 2} fixture files + _meta.json to:\n  ${FIXTURES_DIR}`);
  console.log('Inspect the diff, then commit both halves of every changed pair together.');
}

main().catch((err) => {
  console.error('\nCapture failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
