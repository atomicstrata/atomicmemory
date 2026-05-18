/**
 * @file Shared Zod schemas reused across request/response bodies.
 *
 * All schemas author fields in **snake_case** (the wire format). The
 * Phase-2 request schemas layer `.transform()` on top to emit the
 * camelCase TypeScript shapes handlers expect, matching today's
 * `parseIngestBody` / `parseSearchBody` behavior.
 *
 * Source-of-truth contracts:
 *   - WorkspaceContext / AgentScope: `src/db/repository-types.ts:186-199`
 *   - Body parsing shape:            `src/routes/memories.ts:515-628`
 */

import { z } from './zod-setup.js';

/**
 * Canonical RFC-4122 hyphenated UUID regex. Promoted to `common.ts`
 * so `documents.ts` and `memories.ts` (and any future schema with a
 * UUID path param) all match the same pattern. The `/i` flag mirrors
 * pgcrypto's case-insensitive UUID output.
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Factory for the canonical `:id` path-parameter Zod schema used by
 * `GET/DELETE /v1/documents/:id`, the per-memory routes, and any
 * future UUID-keyed resource. Returns a fresh Zod chain on each call
 * so openapi component registration stays scoped to each call site.
 */
export function makeUuidPathParamSchema() {
  return z
    .object({
      // The .openapi() tag pins `format: "uuid"` in the emitted spec
      // instead of letting zod-to-openapi stringify the JS regex literal
      // (including the `/i` flag) as a JSON Schema `pattern`, which is
      // not a valid regex string per the OpenAPI pattern spec.
      id: z
        .string()
        .regex(UUID_REGEX, 'id must be a valid UUID')
        .openapi({ type: 'string', format: 'uuid' }),
    })
    .transform(p => ({ id: p.id }));
}

export const MemoryVisibilitySchema = z
  .enum(['agent_only', 'restricted', 'workspace'])
  .openapi({
    description:
      'Write-time visibility label controlling which agents in a workspace can read the memory.',
  });

export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

/**
 * Request-body-level schema for the three top-level workspace fields
 * (`workspace_id`, `agent_id`, `visibility`).
 *
 * ⚠️ Behavior must match `parseOptionalWorkspaceContext`
 * (`src/routes/memories.ts:601-615`). Current parser calls
 * `optionalBodyString`, which returns the value unchanged when it is
 * a string and `undefined` otherwise — it **never 400s**. Then the
 * parser treats missing `workspace_id` / `agent_id` (including empty
 * string, which fails the `!workspaceId` truthy check) as "no
 * workspace context" and falls back to user scope.
 *
 * Both field schemas therefore silently coerce any invalid or empty
 * value to `undefined` via `.catch(undefined)`. Phase 2's route
 * schemas compose these as top-level body fields and run a transform
 * that emits the internal {@link WorkspaceContext} camelCase shape
 * only when both are non-empty strings.
 */
// These use `.unknown().transform(...)` rather than `.optional().catch()`
// because zod-to-openapi's traversal fails on ZodCatch nodes. The
// runtime semantics are identical (non-string / empty → undefined).
const VALID_VISIBILITIES: MemoryVisibility[] = ['agent_only', 'restricted', 'workspace'];

export const WorkspaceIdField = z
  .unknown()
  .transform(v => (typeof v === 'string' && v.length > 0 ? v : undefined))
  .openapi({
    type: 'string',
    description: 'Optional workspace identifier. Silently dropped if empty / non-string.',
  });

export const AgentIdField = z
  .unknown()
  .transform(v => (typeof v === 'string' && v.length > 0 ? v : undefined))
  .openapi({
    type: 'string',
    description: 'Optional agent identifier. Silently dropped if empty / non-string.',
  });

export const VisibilityField = z
  .unknown()
  .transform(v =>
    typeof v === 'string' && (VALID_VISIBILITIES as string[]).includes(v)
      ? (v as MemoryVisibility)
      : undefined,
  )
  .openapi({
    type: 'string',
    enum: VALID_VISIBILITIES,
    description:
      'Visibility (one of agent_only / restricted / workspace). Invalid values silently drop to undefined.',
  });

/**
 * Post-transform camelCase `WorkspaceContext` output shape consumed by
 * services. Both fields are required here because this schema
 * represents the "workspace is active" branch of the transform;
 * absence is expressed at the parent level as `workspace: undefined`.
 *
 * Matches `WorkspaceContext` in `src/db/repository-types.ts:186`.
 */
export const WorkspaceContextOutputSchema = z
  .object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    visibility: MemoryVisibilitySchema.optional(),
  })
  .openapi({
    description:
      'Internal workspace-scope context. Emitted by request-body transforms when both workspace_id and agent_id are present on the wire.',
  });

export type WorkspaceContext = z.infer<typeof WorkspaceContextOutputSchema>;

/**
 * Agent-scope filter for workspace searches.
 * Accepts:
 *   - 'all' | 'self' | 'others' — enum variants
 *   - a concrete agent_id string — filter to that agent's memories
 *   - string[] — filter to any of the listed agent IDs
 *
 * ⚠️ Behavior must match `parseOptionalAgentScope`
 * (`src/routes/memories.ts:617`): for values that are neither a
 * string nor a string-only array, the parser returns `undefined`
 * silently (no 400). `.catch(undefined)` preserves that tolerance so
 * Phase 2 composition does not regress `agent_scope: 42` /
 * `agent_scope: {}` from "ignored" to a 400.
 */
export const AgentScopeSchema = z
  .unknown()
  .transform(v => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.every((x: unknown) => typeof x === 'string')) {
      return v as string[];
    }
    return undefined;
  })
  .openapi({
    description:
      "Agent-scope filter for workspace searches. String literal 'all' | 'self' | 'others' or a concrete agent_id. Array of agent_ids is also accepted. Any other value is silently ignored.",
    example: 'all',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  });

export type AgentScopeInput = z.infer<typeof AgentScopeSchema>;

/** Retrieval mode enum for POST /v1/memories/search body.retrieval_mode. */
export const RetrievalModeSchema = z
  .enum(['flat', 'tiered', 'abstract-aware'])
  .openapi({
    description: 'Retrieval pipeline mode. Defaults to flat when omitted.',
  });

export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

/**
 * Required string field — truthy string, no trimming. Exactly matches
 * the contract of `requireBodyString` (`src/routes/memories.ts:571`):
 *
 * ```ts
 * if (!value || typeof value !== 'string') throw new InputError(message);
 * return value;
 * ```
 *
 * Note the absence of a trim: today's handlers pass through leading /
 * trailing whitespace, and "   " (whitespace-only) is truthy so it
 * succeeds the current check. This schema preserves that exact
 * behavior — do not add `.trim()` or a whitespace-only rejection here.
 */
export const NonEmptyString = z.string().min(1, 'must be a non-empty string');

/**
 * Matches `optionalBodyString` (memories.ts:576): `typeof v === 'string'
 * ? v : undefined`. Preserves empty string verbatim — callers may
 * distinguish `""` from `undefined` downstream (e.g. search filters).
 *
 * Shared between every Zod request schema that accepts an optional
 * string body field; do not redefine in resource-specific schema files.
 */
export const OptionalBodyString = z
  .unknown()
  .transform(v => (typeof v === 'string' ? v : undefined))
  .openapi({ type: 'string' });

/**
 * Build a schema that produces the exact error message
 * `"${label} (string) is required"` for every failure mode that
 * `requireBodyString` threw on (missing, null, wrong type, empty
 * string). Preserves wire-contract text clients may match against.
 *
 * Shared between every Zod request schema that requires a non-empty
 * string body field; do not redefine in resource-specific schema files.
 */
export function requiredStringBody(label: string) {
  const message = `${label} (string) is required`;
  return z
    .unknown()
    .refine((v): v is string => typeof v === 'string' && v.length > 0, {
      message,
    })
    .transform(v => v as string)
    .openapi({ type: 'string', minLength: 1, description: `Required. ${label}.` });
}

/**
 * ISO-8601 timestamp accepted as a plain string on the wire. The
 * memories/search route parses this via `parseOptionalIsoTimestamp`
 * (`src/routes/memories.ts:641`):
 *   - `undefined`, `null`, or `''` → treated as absent (no 400).
 *   - Any other non-string or unparseable string → 400.
 *   - Parseable string → passed through unchanged.
 *
 * Preprocess strips the empty-string / null sentinels before the
 * string+date check so composing `IsoTimestamp` into a route body
 * preserves the "empty means absent" contract exactly.
 */
export const IsoTimestamp = z
  .unknown()
  .superRefine((v, ctx) => {
    if (v === undefined || v === null || v === '') return;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      ctx.addIssue({ code: 'custom', message: 'as_of must be a valid ISO timestamp' });
    }
  })
  .transform(v =>
    v === undefined || v === null || v === '' ? undefined : (v as string),
  )
  .openapi({
    type: 'string',
    format: 'date-time',
    description:
      'ISO-8601 timestamp accepted by temporal search (as_of). Empty string or null means absent; any other non-ISO value is rejected with 400.',
    example: '2026-01-15T12:00:00Z',
  });
