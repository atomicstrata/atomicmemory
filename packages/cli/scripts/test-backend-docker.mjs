#!/usr/bin/env node
/**
 * @file Deterministic backend-smoke harness for the AtomicMemory CLI.
 *
 * Runs the opt-in `pnpm -C packages/cli test:backend` suite against a
 * real `packages/core` Docker stack started + torn down here. The
 * test:backend suite is `node:test`-skipped without
 * `ATOMICMEMORY_TEST_BACKEND=1`, so this harness is the canonical way
 * to actually exercise it locally.
 *
 * Mirrors the core package's own
 * `scripts/docker-smoke-test.sh` pattern (port resolution → unique
 * compose project → bring up `docker-compose.yml` + `docker-compose.smoke.yml`
 * → poll the real `/health` endpoint with a bounded timeout → run
 * the consumer's tests → tear down). Polling is on a real condition
 * (HTTP 2xx from `/health`) — there is no sleep-only readiness assumption.
 *
 * Configuration env vars (all optional):
 *   ATOMICMEMORY_CORE_PATH     Path to the core package root. Default:
 *                              sibling `../core` from packages/cli.
 *   ATOMICMEMORY_DOCKER_APP_PORT      Port to publish core's app on
 *                                     (default: pick a free port
 *                                     starting at 3060).
 *   ATOMICMEMORY_DOCKER_POSTGRES_PORT Port to publish core's pg on
 *                                     (default: pick a free port
 *                                     starting at 5444).
 *   ATOMICMEMORY_DOCKER_HEALTH_TIMEOUT  Bounded health-poll cap in
 *                                       seconds (default: 90).
 *   ATOMICMEMORY_DOCKER_HEALTH_INTERVAL Poll interval seconds
 *                                       (default: 2).
 *   ATOMICMEMORY_DOCKER_SKIP_BUILD=1    Reuse existing compose images
 *                                       instead of `--build`.
 *   ATOMICMEMORY_DOCKER_KEEP_UP=1       Skip the teardown step (debug).
 */

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const HARNESS_DOCKER_DIR = resolve(HERE, 'docker');
const HARNESS_OVERLAY_FILE = resolve(HARNESS_DOCKER_DIR, 'docker-compose.cli-backend.yml');

const env = process.env;
const HEALTH_TIMEOUT_S = readPositiveInt(env.ATOMICMEMORY_DOCKER_HEALTH_TIMEOUT, 90);
const HEALTH_INTERVAL_S = readPositiveInt(env.ATOMICMEMORY_DOCKER_HEALTH_INTERVAL, 2);
const SKIP_BUILD = env.ATOMICMEMORY_DOCKER_SKIP_BUILD === '1';
const KEEP_UP = env.ATOMICMEMORY_DOCKER_KEEP_UP === '1';

let composeProject = '';
let coreRoot = '';

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`, 'error');
    process.exit(1);
  });

async function main() {
  preflight();
  coreRoot = resolveCoreRoot();
  const appPort = await pickPort(env.ATOMICMEMORY_DOCKER_APP_PORT, 3060);
  const pgPort = await pickPort(env.ATOMICMEMORY_DOCKER_POSTGRES_PORT, 5444);
  composeProject = `atomicmemory-cli-backend-${appPort}-${pgPort}`;
  registerTeardown();

  log(`core path: ${coreRoot}`);
  log(`compose project: ${composeProject} (app=${appPort}, postgres=${pgPort})`);

  bringUp(appPort, pgPort);
  await waitForHealth(appPort);
  buildCli();
  return runBackendSuite(appPort);
}

function preflight() {
  for (const cmd of ['docker', 'pnpm']) {
    if (!hasCommand(cmd)) {
      throw new Error(`required command not found on PATH: ${cmd}`);
    }
  }
  const ver = spawnSync('docker', ['compose', 'version'], { stdio: 'pipe' });
  if (ver.status !== 0) {
    throw new Error('`docker compose` (v2 plugin) is required; got non-zero exit checking version');
  }
  const info = spawnSync('docker', ['info'], { stdio: 'pipe' });
  if (info.status !== 0) {
    throw new Error('docker daemon is not running (`docker info` failed)');
  }
}

function hasCommand(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'pipe' }).status === 0;
}

function resolveCoreRoot() {
  const override = env.ATOMICMEMORY_CORE_PATH;
  const candidates = override
    ? [override]
    : [resolve(REPO_ROOT, 'core')];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (!statSync(c).isDirectory()) continue;
    if (!existsSync(resolve(c, 'docker-compose.yml'))) continue;
    if (!existsSync(resolve(c, 'docker-compose.smoke.yml'))) continue;
    return c;
  }
  throw new Error(
    `could not locate a core package with docker-compose.yml + docker-compose.smoke.yml. ` +
      `Set ATOMICMEMORY_CORE_PATH to the core package root. Tried: ${candidates.join(', ')}`,
  );
}

async function pickPort(requested, fallbackBase) {
  const dockerBusy = listDockerPublishedPorts();
  if (requested) {
    const n = Number(requested);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`invalid port override: ${requested}`);
    }
    if (await isPortAvailable(n, dockerBusy)) return n;
    throw new Error(
      `requested port ${n} is already in use (host bind or docker publish)`,
    );
  }
  for (let p = fallbackBase; p < fallbackBase + 200; p++) {
    if (await isPortAvailable(p, dockerBusy)) return p;
  }
  throw new Error(`no free port available starting at ${fallbackBase}`);
}

async function isPortAvailable(port, dockerBusy) {
  if (dockerBusy.has(port)) return false;
  return isPortFree(port);
}

function isPortFree(port) {
  return new Promise((resolveP) => {
    const srv = createServer();
    srv.once('error', () => resolveP(false));
    srv.once('listening', () => srv.close(() => resolveP(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Collect every host port currently published by a docker container
 * — `isPortFree` only checks whether the host can bind, but docker
 * can hold a publish even when nothing is actively listening (so a
 * later `docker compose up` would fail with "port is already
 * allocated"). Falls back to an empty set if `docker ps` is
 * unavailable; the OS-level bind check then catches what it can.
 */
function listDockerPublishedPorts() {
  const r = spawnSync('docker', ['ps', '--format', '{{.Ports}}'], { stdio: 'pipe' });
  const busy = new Set();
  if (r.status !== 0) return busy;
  const text = r.stdout.toString();
  // Match `0.0.0.0:PORT->`, `[::]:PORT->`, `127.0.0.1:PORT->`, etc.
  const re = /(?:^|[\s,])(?:[\d.[:\]a-fA-F]+:)?(\d{1,5})->/g;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && n <= 65535) busy.add(n);
  }
  return busy;
}

function bringUp(appPort, pgPort) {
  log(`docker compose up${SKIP_BUILD ? '' : ' --build'} (this may take a few minutes on first run)…`);
  // Layer order matters: core base → core smoke (transformers
  // embedding, dummy OpenAI key, port 17350) → CLI overlay (routes
  // LLM at the mock-openai-extraction service so /v1/memories/ingest
  // actually returns 200 instead of 401).
  const args = [
    'compose',
    '-p', composeProject,
    '-f', 'docker-compose.yml',
    '-f', 'docker-compose.smoke.yml',
    '-f', HARNESS_OVERLAY_FILE,
    'up', '-d',
  ];
  if (!SKIP_BUILD) args.push('--build');
  const result = spawnSync('docker', args, {
    cwd: coreRoot,
    stdio: 'inherit',
    env: {
      ...env,
      APP_PORT: String(appPort),
      POSTGRES_PORT: String(pgPort),
      ATOMICMEMORY_CLI_MOUNT: HARNESS_DOCKER_DIR,
    },
  });
  if (result.status !== 0) {
    throw new Error(`docker compose up failed (exit ${result.status})`);
  }
}

async function waitForHealth(appPort) {
  const url = `http://127.0.0.1:${appPort}/health`;
  log(`waiting for ${url} (timeout=${HEALTH_TIMEOUT_S}s, interval=${HEALTH_INTERVAL_S}s)…`);
  const deadlineMs = Date.now() + HEALTH_TIMEOUT_S * 1000;
  let attempts = 0;
  while (Date.now() < deadlineMs) {
    attempts += 1;
    const ok = await probeHealth(url);
    if (ok) {
      log(`app healthy after ${attempts} probe(s)`);
      return;
    }
    await sleep(HEALTH_INTERVAL_S * 1000);
  }
  await dumpAppLogs();
  throw new Error(`app did not report healthy at ${url} within ${HEALTH_TIMEOUT_S}s`);
}

async function probeHealth(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(HEALTH_INTERVAL_S, 5) * 1000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function dumpAppLogs() {
  log('--- last 60 lines of app container logs ---', 'warn');
  spawnSync('docker', ['compose', '-p', composeProject, 'logs', '--tail', '60', 'app'], {
    cwd: coreRoot,
    stdio: 'inherit',
  });
}

function buildCli() {
  log('pnpm -C packages/cli build');
  const r = spawnSync('pnpm', ['-C', CLI_ROOT, 'build'], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) {
    throw new Error(`pnpm build failed (exit ${r.status})`);
  }
}

function runBackendSuite(appPort) {
  const apiUrl = `http://127.0.0.1:${appPort}`;
  log(`pnpm -C packages/cli test:backend  (ATOMICMEMORY_TEST_API_URL=${apiUrl})`);
  const r = spawnSync('pnpm', ['-C', CLI_ROOT, 'test:backend'], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: {
      ...env,
      ATOMICMEMORY_TEST_BACKEND: '1',
      ATOMICMEMORY_TEST_API_URL: apiUrl,
    },
  });
  if (r.status === null) throw new Error('test:backend was killed by a signal');
  return r.status;
}

function registerTeardown() {
  let ran = false;
  const tearDown = () => {
    if (ran) return;
    ran = true;
    if (KEEP_UP) {
      log(`KEEP_UP=1 — leaving compose stack ${composeProject} running for inspection`, 'warn');
      return;
    }
    log(`tearing down compose stack ${composeProject}…`);
    spawnSync(
      'docker',
      [
        'compose',
        '-p', composeProject,
        '-f', 'docker-compose.yml',
        '-f', 'docker-compose.smoke.yml',
        '-f', HARNESS_OVERLAY_FILE,
        'down', '-v', '--remove-orphans',
      ],
      {
        cwd: coreRoot,
        stdio: 'inherit',
        env: { ...env, ATOMICMEMORY_CLI_MOUNT: HARNESS_DOCKER_DIR },
      },
    );
  };
  process.on('exit', tearDown);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      tearDown();
      process.exit(130);
    });
  }
}

function readPositiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`expected a positive integer; got ${JSON.stringify(raw)}`);
  }
  return n;
}

function log(message, level = 'info') {
  const tag = level === 'error' ? '[backend-docker:error]'
    : level === 'warn' ? '[backend-docker:warn]'
    : '[backend-docker]';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${tag} ${message}\n`);
}
