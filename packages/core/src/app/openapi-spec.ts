/**
 * Committed OpenAPI spec loader for the unauthenticated `GET /openapi.json`
 * route.
 *
 * The spec is generated at build time by `scripts/generate-openapi.ts` into the
 * package-root `openapi.json` (committed; shipped via package.json `files`).
 * This module reads that file ONCE at module load — a process-boundary read, not
 * a per-request disk hit — parses it, and asserts the contract fields a consumer
 * relies on (`openapi`, `info.version`, `paths`). A missing or malformed spec is
 * a build/packaging defect, so it fails loudly at startup rather than degrading.
 *
 * Path resolution: this file lives at `<pkg>/src/app/` in dev (tsx) and compiles
 * to `<pkg>/dist/app/` in the published build; `../../openapi.json` resolves to
 * the package root in both layouts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal shape the `/openapi.json` route guarantees to its consumers. */
export interface OpenApiSpec {
  openapi: string;
  info: { version: string; title?: string };
  paths: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Load and validate the committed OpenAPI spec. Exported for tests; the route
 * wiring consumes the eagerly-loaded `openApiSpec` singleton below.
 */
export function loadOpenApiSpec(): OpenApiSpec {
  const specPath = resolve(import.meta.dirname, '..', '..', 'openapi.json');
  const parsed = JSON.parse(readFileSync(specPath, 'utf8')) as Partial<OpenApiSpec>;

  if (typeof parsed.openapi !== 'string' || parsed.openapi.length === 0) {
    throw new Error(`openapi-spec: ${specPath} is missing a string "openapi" version field`);
  }
  if (!parsed.info || typeof parsed.info.version !== 'string' || parsed.info.version.length === 0) {
    throw new Error(`openapi-spec: ${specPath} is missing "info.version"`);
  }
  if (!parsed.paths || typeof parsed.paths !== 'object') {
    throw new Error(`openapi-spec: ${specPath} is missing a "paths" object`);
  }

  return parsed as OpenApiSpec;
}

/**
 * Eagerly loaded committed spec. Loading at module import (not per request)
 * keeps `GET /openapi.json` off the disk in the hot path and surfaces a
 * packaging defect at process startup.
 */
export const openApiSpec: OpenApiSpec = loadOpenApiSpec();
