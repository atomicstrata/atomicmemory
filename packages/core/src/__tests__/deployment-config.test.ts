/**
 * Deployment configuration validation tests.
 *
 * Catches misconfiguration regressions that only manifest at deploy time:
 *   - Provider URLs resolving to unreachable hosts inside containers
 *   - docker-compose.yml env vars diverging from config.ts defaults
 *   - Health endpoint not exposing provider config for diagnostics
 *   - Missing env var coverage in .env.example
 *
 * These tests run without Docker — they validate the config layer and
 * compose file statically. The docker-smoke-test.sh script covers the
 * live deployment shape.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function readComposeRaw(): string {
  return readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf-8');
}

function readEnvExample(): string {
  return readFileSync(resolve(ROOT, '.env.example'), 'utf-8');
}

function readDockerfile(): string {
  return readFileSync(resolve(ROOT, 'Dockerfile'), 'utf-8');
}

/**
 * Extract a specific env var value from the compose file's app service
 * environment block. Handles both YAML mapping and shell-variable syntax.
 */
function extractComposeEnvVar(composeContent: string, varName: string): string | null {
  const pattern = new RegExp(`^\\s+${varName}:\\s*(.+)$`, 'm');
  const match = composeContent.match(pattern);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * Build a regex that matches a docker-compose `ports:` list entry binding
 * an external host port to the given internal container port. Accepts both
 * a literal external port (`"3050:3050"`) and a shell-variable substitution
 * (`"${APP_PORT:-3050}:3050"`). The substitution form is the side-by-side-CI
 * shape introduced in PR #6.
 */
function composePortBindingRegex(internalPort: number): RegExp {
  return new RegExp(
    `ports:\\s*\\n\\s*-\\s*["']?(?:\\d+|\\$\\{[A-Z_]+:-\\d+\\}):${internalPort}`,
  );
}

describe('deployment configuration', () => {
  describe('docker-compose.yml', () => {
    it('app service uses host.docker.internal for OLLAMA_BASE_URL, not localhost', () => {
      const compose = readComposeRaw();
      const ollamaUrl = extractComposeEnvVar(compose, 'OLLAMA_BASE_URL');

      expect(ollamaUrl).toBeDefined();
      // The exact bug: if OLLAMA_BASE_URL defaults to localhost inside the
      // container, requests to the host ollama will fail with ECONNREFUSED.
      expect(ollamaUrl).not.toContain('://localhost');
      expect(ollamaUrl).toContain('host.docker.internal');
    });

    it('app service DATABASE_URL points to postgres service, not localhost', () => {
      const compose = readComposeRaw();
      const dbUrl = extractComposeEnvVar(compose, 'DATABASE_URL');

      expect(dbUrl).toBeDefined();
      // Inside compose, DB is at service name "postgres", not localhost
      expect(dbUrl).toContain('@postgres:');
      expect(dbUrl).not.toContain('@localhost');
    });

    it('DATABASE_URL uses internal port 5432, not host-mapped 5433', () => {
      const compose = readComposeRaw();
      const dbUrl = extractComposeEnvVar(compose, 'DATABASE_URL');

      // Inside compose, containers talk on the internal network port (5432)
      // The host-mapped port (5433) is only for external access
      expect(dbUrl).toContain(':5432/');
      expect(dbUrl).not.toContain(':5433');
    });

    it('OLLAMA_BASE_URL does not use 127.0.0.1', () => {
      const compose = readComposeRaw();
      const ollamaUrl = extractComposeEnvVar(compose, 'OLLAMA_BASE_URL');

      expect(ollamaUrl).not.toContain('127.0.0.1');
    });

    it('app depends on postgres with health condition', () => {
      const compose = readComposeRaw();
      expect(compose).toContain('depends_on:');
      expect(compose).toContain('condition: service_healthy');
    });

    it('postgres has a healthcheck configured', () => {
      const compose = readComposeRaw();
      expect(compose).toContain('healthcheck:');
      expect(compose).toContain('pg_isready');
    });

    it('extra_hosts maps host.docker.internal for Linux compatibility', () => {
      const compose = readComposeRaw();
      expect(compose).toContain('extra_hosts:');
      expect(compose).toContain('host.docker.internal');
    });

    it('app port is exposed', () => {
      const compose = readComposeRaw();
      expect(compose).toMatch(composePortBindingRegex(3050));
    });
  });

  describe('.env.example coverage', () => {
    it('documents DATABASE_URL', () => {
      expect(readEnvExample()).toContain('DATABASE_URL');
    });

    it('documents OPENAI_API_KEY', () => {
      expect(readEnvExample()).toContain('OPENAI_API_KEY');
    });

    it('documents PORT', () => {
      expect(readEnvExample()).toContain('PORT');
    });

    it('documents EMBEDDING_DIMENSIONS', () => {
      expect(readEnvExample()).toContain('EMBEDDING_DIMENSIONS');
    });

    it('documents Docker startup migration controls', () => {
      const envExample = readEnvExample();
      expect(envExample).toContain('ATOMICMEMORY_RUN_MIGRATIONS_ON_STARTUP');
      expect(envExample).toContain('MIGRATION_LOCK_TIMEOUT_MS');
    });

    it('documents Voyage embedding lane env vars', () => {
      const envExample = readEnvExample();
      expect(envExample).toContain('VOYAGE_API_KEY');
      expect(envExample).toContain('VOYAGE_DOCUMENT_MODEL');
      expect(envExample).toContain('VOYAGE_QUERY_MODEL');
    });
  });

  describe('Dockerfile', () => {
    it('uses the entrypoint to coordinate migrations before server start', () => {
      const dockerfile = readDockerfile();
      const entrypointLine = dockerfile.split('\n').find((l) => l.startsWith('ENTRYPOINT'));
      const cmdLine = dockerfile.split('\n').find((l) => l.startsWith('CMD'));

      expect(entrypointLine).toBeDefined();
      expect(entrypointLine).toContain('docker-entrypoint.sh');
      expect(cmdLine).toBeDefined();
      expect(cmdLine).toContain('server');
    });

    it('entrypoint exposes startup migration controls for rolling deploys', () => {
      const entrypoint = readFileSync(resolve(ROOT, 'scripts/docker-entrypoint.sh'), 'utf-8');

      expect(entrypoint).toContain('ATOMICMEMORY_RUN_MIGRATIONS_ON_STARTUP');
      expect(entrypoint).toContain('MIGRATION_LOCK_TIMEOUT_MS');
      expect(entrypoint).toContain('--lock-timeout-ms=');
      expect(entrypoint.indexOf('run_migrations')).toBeLessThan(
        entrypoint.indexOf('Starting AtomicMemory Core'),
      );
    });

    it('defaults DATABASE_URL to embedded mode for single-container docker run', () => {
      const dockerfile = readDockerfile();

      expect(dockerfile).toContain('FROM pgvector/pgvector:pg17');
      expect(dockerfile).toContain('ENV DATABASE_URL=embedded');
      expect(dockerfile).toContain('ENV EMBEDDING_DIMENSIONS=1536');
      expect(dockerfile).toContain('ENV RAW_STORAGE_DEPLOYMENT_ENV=local');
      expect(dockerfile).toContain('EMBEDDED_POSTGRES_DATA_DIR');
    });

    it('entrypoint provides local Docker auth and storage defaults', () => {
      const entrypoint = readFileSync(resolve(ROOT, 'scripts/docker-entrypoint.sh'), 'utf-8');

      expect(entrypoint).toContain('LOCAL_DOCKER_CORE_API_KEY="local-dev-key"');
      expect(entrypoint).toContain('LOCAL_DOCKER_STORAGE_KEY_HMAC_SECRET=');
      expect(entrypoint).toContain('RAW_STORAGE_DEPLOYMENT_ENV=production');
    });

    it('creates non-root user', () => {
      const dockerfile = readDockerfile();
      expect(dockerfile).toContain('useradd');
      expect(dockerfile).toContain('USER');
    });

    it('copies tsconfig.json for tsx runtime', () => {
      const dockerfile = readDockerfile();
      expect(dockerfile).toContain('tsconfig.json');
    });
  });
});
