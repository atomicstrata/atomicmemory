/**
 * @file v5 CLI config zod model — single source of truth for both runtime
 * validation and the generated `config.schema.json`. Per v5 §"Config +
 * named profiles": named profiles, schema_version "2", canonical
 * `agent_id` scope field (NOT V0's `agent`), strict shape (extra keys
 * rejected so spelling mistakes don't silently no-op).
 *
 * `config.schema.json` is regenerated from this model by
 * `scripts/generate-config-schema.mjs` and CI fails on drift.
 */

import { z } from 'zod';

const OUTPUT_MODES = ['text', 'json', 'agent', 'table', 'quiet'] as const;
const TRUST_SURFACES = [
  'local',
  'self-hosted',
  'authenticated-wrapper',
] as const;
export const PROVIDERS = ['atomicmemory', 'mem0'] as const;

export const SCHEMA_VERSION = '2' as const;

/**
 * Canonical CLI scope. agent_id is the v5 surface name; Phase 4
 * adapters map it onto the SDK's Scope.agent field internally.
 */
export const CliScopePartialSchema = z
  .object({
    user: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    thread: z.string().min(1).optional(),
  })
  .strict();

export const CliProfileSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    apiUrl: z.string().url(),
    trustSurface: z.enum(TRUST_SURFACES),
    scope: CliScopePartialSchema.optional(),
    output: z.enum(OUTPUT_MODES).optional(),
    /**
     * Persisted only by interactive `init` (with consent) or by
     * non-interactive `init --api-key-stdin --save-api-key`. Non-init
     * commands never write this field.
     */
    apiKey: z.string().min(1).optional(),
  })
  .strict();

export const CliConfigSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    activeProfile: z.string().min(1),
    profiles: z.record(z.string().min(1), CliProfileSchema),
  })
  .strict();

export type CliProfileShape = z.infer<typeof CliProfileSchema>;
export type CliConfigShape = z.infer<typeof CliConfigSchema>;

/**
 * Shape of a freshly-bootstrapped config (no profiles yet). `init` with
 * no arguments creates the `default` profile; until then this is the
 * default-loaded value.
 */
export function emptyConfig(): CliConfigShape {
  return {
    schema_version: SCHEMA_VERSION,
    activeProfile: 'default',
    profiles: {},
  };
}
