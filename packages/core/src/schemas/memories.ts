/**
 * @file Zod schemas for every /v1/memories/* route.
 *
 * Each request body schema authors fields in **snake_case** (the wire
 * format) and `.transform()`s to a camelCase output consumed by
 * handlers. The output shape of each schema was chosen to drop-in
 * replace the value previously returned by `parseIngestBody` /
 * `parseSearchBody` etc. so handler bodies don't change.
 *
 * ⚠️ Behavior-preservation invariants worth noting:
 *   - `requireBodyString` rejects empty string AND non-string with
 *     the same 400 message. `requiredStringBody(label)` below emits
 *     the exact "${label} (string) is required" text for every
 *     failure mode (missing, null, wrong type, empty).
 *   - `parseOptionalWorkspaceContext` / `parseOptionalAgentScope`
 *     NEVER 400 on invalid shapes — they silently drop to undefined.
 *     Composition here uses the `.catch(undefined)` primitives from
 *     `./common`.
 *   - `parseOptionalIsoTimestamp` treats `''` and `null` as absent,
 *     rejects other invalid strings. `IsoTimestamp` in `./common`
 *     preserves that with a preprocess step.
 *   - `retrieval_mode` absence is silent (undefined), invalid values
 *     throw the exact message from memories.ts:553-555.
 *   - `token_budget` must be a finite number in [100, 50000], floored
 *     on success. Matches memories.ts:560-568.
 *   - `limit` on POST /search / /search/fast bodies: non-number yields
 *     undefined (not an error); number is clamped to
 *     [1, MAX_SEARCH_LIMIT=100] and floored. Matches memories.ts:629-632.
 *   - `conversation` max length = 100_000 chars. Over the limit
 *     throws 'conversation exceeds max length of 100000 characters'.
 *
 * Source: `src/routes/memories.ts:515-647` (the inline parsers this
 * file replaces).
 */

import { z } from './zod-setup.js';
import {
  IsoTimestamp,
  RetrievalModeSchema,
  MemoryVisibilitySchema,
  AgentScopeSchema,
  WorkspaceIdField,
  AgentIdField,
  VisibilityField,
  OptionalBodyString,
  UUID_REGEX,
  makeUuidPathParamSchema,
  requiredStringBody,
  type WorkspaceContext,
} from './common.js';
import { RESERVED_METADATA_KEYS } from '../db/repository-types.js';

// ---------------------------------------------------------------------------
// Constants mirroring memories.ts limits
// ---------------------------------------------------------------------------

const MAX_CONVERSATION_LENGTH = 100_000;
const MAX_METADATA_SERIALIZED_BYTES = 32 * 1024;
const MAX_SEARCH_LIMIT = 100;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TOKEN_BUDGET = 50_000;
const MIN_TOKEN_BUDGET = 100;
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------
// Reusable body-level field schemas
// ---------------------------------------------------------------------------

// `OptionalBodyString` and `requiredStringBody` are imported from
// `./common.js` so /v1/documents/* and other future resource schemas can
// reuse the same wire-contract behavior without copying the helpers.

/** Boolean field that silently coerces non-boolean inputs to undefined. */
const OptionalBooleanField = (description?: string) =>
  z
    .unknown()
    .transform(v => (typeof v === 'boolean' ? v : undefined))
    .openapi({ type: 'boolean', ...(description ? { description } : {}) });

const SessionIdField = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_id must be a string',
      });
      return;
    }
    if (value.length === 0 || value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_id must be a non-empty string without control characters',
      });
    }
    if (value.length > MAX_SESSION_ID_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `session_id exceeds ${MAX_SESSION_ID_LENGTH} characters`,
      });
    }
    if (CONTROL_CHAR_REGEX.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_id must be a non-empty string without control characters',
      });
    }
  })
  .transform(value => (typeof value === 'string' ? value : undefined))
  .openapi({
    type: 'string',
    maxLength: MAX_SESSION_ID_LENGTH,
    description:
      'Optional thread/session identifier used to scope ingest, search, and list symmetrically.',
  });

/**
 * Build a schema that produces `"${label} (string[]) is required"` for
 * every failure mode that the old array guard threw on. Matches the
 * memory_ids check at memories.ts:213-215.
 */
function requiredStringArrayBody(label: string) {
  const message = `${label} (string[]) is required`;
  return z
    .unknown()
    .refine(
      (v): v is string[] =>
        Array.isArray(v) && v.every(x => typeof x === 'string'),
      { message },
    )
    .transform(v => v as string[])
    .openapi({
      type: 'array',
      items: { type: 'string' },
      description: `Required. ${label}.`,
    });
}

/** POST /search and /search/fast accept body.limit as a number only; other types → undefined. */
const SearchBodyLimit = z
  .preprocess(
    v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
    z.number().optional(),
  )
  .transform(n =>
    typeof n === 'number'
      ? Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(n)))
      : undefined,
  )
  .openapi({ type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT });

/** token_budget: finite number in [100, 50000], floored. Throws on invalid. */
const TokenBudgetSchema = optionalFiniteNumber('token_budget')
  .refine(
    v =>
      v === undefined ||
      (typeof v === 'number' &&
        v >= MIN_TOKEN_BUDGET &&
        v <= MAX_TOKEN_BUDGET),
    {
      message: `token_budget must be between ${MIN_TOKEN_BUDGET} and ${MAX_TOKEN_BUDGET}`,
    },
  )
  .transform(v => (typeof v === 'number' ? Math.floor(v) : undefined))
  .openapi({ type: 'integer', minimum: MIN_TOKEN_BUDGET, maximum: MAX_TOKEN_BUDGET });

/** threshold: normalized relevance floor in [0, 1]. Throws on invalid. */
const SearchThresholdSchema = optionalFiniteNumber('threshold')
  .refine(
    v => v === undefined || (v >= 0 && v <= 1),
    { message: 'threshold must be between 0 and 1' },
  )
  .transform(v => (typeof v === 'number' ? v : undefined))
  .openapi({
    type: 'number',
    minimum: 0,
    maximum: 1,
    description:
      'Optional normalized relevance threshold. Results below this semantic relevance floor are excluded before injection packaging.',
  });

function optionalFiniteNumber(label: string) {
  return z
    .preprocess(v => (v === undefined || v === null ? undefined : v), z.unknown().optional())
    .refine(
      (v): v is number | undefined =>
        v === undefined ||
        (typeof v === 'number' && Number.isFinite(v)),
      { message: `${label} must be a finite number` },
    );
}

/**
 * retrieval_mode: string enum or undefined. Absent/null → undefined;
 * wrong type → throw 'retrieval_mode must be a string'; wrong enum
 * value → throw the full valid-list message. Matches memories.ts:551-557.
 */
const RetrievalModeField = z
  .preprocess(
    v => (v === undefined || v === null ? undefined : v),
    z.unknown().optional(),
  )
  .superRefine((v, ctx) => {
    if (v === undefined) return;
    if (typeof v !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'retrieval_mode must be a string' });
      return;
    }
    if (!['flat', 'tiered', 'abstract-aware'].includes(v)) {
      ctx.addIssue({
        code: 'custom',
        message: `retrieval_mode must be one of: ${['flat', 'tiered', 'abstract-aware'].join(', ')}`,
      });
    }
  })
  .transform(v => (v === undefined ? undefined : (v as z.infer<typeof RetrievalModeSchema>)))
  .openapi({
    type: 'string',
    enum: ['flat', 'tiered', 'abstract-aware'],
  });

// ---------------------------------------------------------------------------
// Per-request config override
// ---------------------------------------------------------------------------

/**
 * Per-request overlay on the startup RuntimeConfig. Applied as a shallow
 * merge (`{ ...startup, ...override }`) onto the effective request-scope
 * config.
 *
 * **Shape is permissive by design.** The schema accepts any object whose
 * values are primitives (boolean, number, string, null) — no
 * enumerated field list. This is deliberate: enumerating fields would
 * couple every new overlay-eligible RuntimeConfig field to a core
 * release, which defeats the purpose of a per-request config mechanism.
 *
 * **Unknown-key handling is soft**, not a 400:
 * - If an override key doesn't match a `RuntimeConfig` field at
 *   request-handling time, the merge is still performed (the key rides
 *   along on the effective config object), but the route handler emits
 *   a `X-Atomicmem-Unknown-Override-Keys` response header listing the
 *   unmatched keys and logs a warning. This catches typos without
 *   rejecting a request that would otherwise be valid once the field
 *   lands in a future release.
 * - If you want a typed, IDE-autocompleted experience, import
 *   `RuntimeConfig` from `src/config.ts` and type your override as
 *   `Partial<RuntimeConfig>` on the caller side.
 *
 * **`config_override` absent →** zero-cost path, no headers emitted,
 * startup config used as-is.
 */
export const ConfigOverrideSchema = z
  .record(
    z.string(),
    z.union([z.boolean(), z.number(), z.string(), z.null()]),
  )
  .openapi({
    description:
      'Optional per-request overlay on RuntimeConfig. Keys correspond to RuntimeConfig field names; values must be primitives (boolean / number / string / null). Unknown keys are accepted but surfaced via the X-Atomicmem-Unknown-Override-Keys response header and a server-side warning log — they do not cause a 400. Scope: just this request — no server mutation.',
  });

/**
 * Runtime type of the validated override object. For IDE-assisted
 * editing, prefer `Partial<RuntimeConfig>` from `src/config.ts`.
 */
export type ConfigOverride = z.infer<typeof ConfigOverrideSchema>;

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const IngestBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    conversation: requiredStringBody('conversation').refine(
      s => s.length <= MAX_CONVERSATION_LENGTH,
      { message: `conversation exceeds max length of ${MAX_CONVERSATION_LENGTH} characters` },
    ),
    source_site: requiredStringBody('source_site'),
    source_url: OptionalBodyString,
    session_id: SessionIdField,
    workspace_id: WorkspaceIdField,
    agent_id: AgentIdField,
    visibility: VisibilityField,
    /** Only POST /ingest/quick reads this — safely ignored elsewhere. */
    skip_extraction: OptionalBooleanField(),
    config_override: ConfigOverrideSchema.optional(),
    /**
     * Caller-supplied metadata, persisted alongside the memory. Only
     * honored on POST /v1/memories/ingest/quick with skip_extraction=true
     * and no workspace context — rejected with 400 on every other branch.
     * Reserved keys (RESERVED_METADATA_KEYS in repository-types) are
     * rejected. Max 32 KB UTF-8 serialized.
     */
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({
        description:
          'Caller-supplied metadata, persisted alongside the memory. ' +
          'Honored ONLY on /v1/memories/ingest/quick with skip_extraction=true ' +
          'and no workspace context — rejected with 400 on every other branch. ' +
          'Reserved keys (RESERVED_METADATA_KEYS in repository-types) are rejected. ' +
          'Max 32 KB UTF-8 serialized.',
      }),
  })
  .refine(
    b =>
      !b.metadata ||
      Buffer.byteLength(JSON.stringify(b.metadata), 'utf8') <=
        MAX_METADATA_SERIALIZED_BYTES,
    {
      message: `metadata exceeds max serialized size of ${MAX_METADATA_SERIALIZED_BYTES} bytes (utf-8)`,
    },
  )
  .superRefine((b, ctx) => {
    if (!b.metadata) return;
    const reserved = Object.keys(b.metadata).filter(k =>
      RESERVED_METADATA_KEYS.has(k),
    );
    if (reserved.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `metadata contains reserved key(s) [${reserved.join(', ')}] — ` +
          `these are core-internal and cannot be set by callers. ` +
          `See RESERVED_METADATA_KEYS in repository-types.`,
      });
    }
  })
  .transform(b => ({
    userId: b.user_id,
    conversation: b.conversation,
    sourceSite: b.source_site,
    sourceUrl: b.source_url ?? '',
    sessionId: b.session_id,
    workspace: buildWorkspaceContext(b.workspace_id, b.agent_id, b.visibility),
    skipExtraction: b.skip_extraction === true,
    configOverride: b.config_override,
    metadata: b.metadata,
  }))
  .openapi({
    description:
      'Ingest a conversation transcript. User-scoped unless workspace_id + agent_id are both provided.',
  });

export type IngestBody = z.infer<typeof IngestBodySchema>;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const SearchBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    query: requiredStringBody('query'),
    // source_site / namespace_scope intentionally preserve empty
    // string — optionalBodyString() did not collapse '' to undefined.
    source_site: OptionalBodyString,
    limit: SearchBodyLimit,
    as_of: IsoTimestamp,
    retrieval_mode: RetrievalModeField,
    token_budget: TokenBudgetSchema,
    threshold: SearchThresholdSchema,
    namespace_scope: OptionalBodyString,
    session_id: SessionIdField,
    skip_repair: OptionalBooleanField(),
    workspace_id: WorkspaceIdField,
    agent_id: AgentIdField,
    visibility: VisibilityField,
    agent_scope: AgentScopeSchema,
    config_override: ConfigOverrideSchema.optional(),
  })
  .transform(b => ({
    userId: b.user_id,
    query: b.query,
    sourceSite: b.source_site,
    limit: b.limit,
    asOf: b.as_of,
    retrievalMode: b.retrieval_mode,
    tokenBudget: b.token_budget,
    relevanceThreshold: b.threshold,
    namespaceScope: b.namespace_scope,
    sessionId: b.session_id,
    skipRepair: b.skip_repair === true,
    workspace: buildWorkspaceContext(b.workspace_id, b.agent_id, b.visibility),
    agentScope: b.agent_scope,
    configOverride: b.config_override,
  }))
  .openapi({
    description:
      'Search memories. User-scoped unless workspace_id + agent_id are both provided.',
  });

export type SearchBody = z.infer<typeof SearchBodySchema>;

// ---------------------------------------------------------------------------
// Expand
// ---------------------------------------------------------------------------

export const ExpandBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    memory_ids: requiredStringArrayBody('memory_ids'),
    workspace_id: WorkspaceIdField,
    agent_id: AgentIdField,
    visibility: VisibilityField,
  })
  .transform(b => ({
    userId: b.user_id,
    memoryIds: b.memory_ids,
    workspace: buildWorkspaceContext(b.workspace_id, b.agent_id, b.visibility),
  }))
  .openapi({
    description: 'Expand a list of memory IDs into full objects.',
  });

export type ExpandBody = z.infer<typeof ExpandBodySchema>;

// ---------------------------------------------------------------------------
// Verify (H5 — Sprint 3 v1.7)
// ---------------------------------------------------------------------------

export const VerifyBodySchema = z
  .object({
    question: requiredStringBody('question'),
    context: requiredStringBody('context'),
    candidate_answer: requiredStringBody('candidate_answer'),
  })
  .transform(b => ({
    question: b.question,
    context: b.context,
    candidateAnswer: b.candidate_answer,
  }))
  .openapi({
    description:
      'Re-ground a candidate answer against retrieved context. Returns the original answer if all specifics are grounded, or a rewritten answer if not.',
  });

export type VerifyBody = z.infer<typeof VerifyBodySchema>;

// ---------------------------------------------------------------------------
// Admin routes (consolidate / decay / cap / reset-source / reconcile)
// ---------------------------------------------------------------------------

export const ConsolidateBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    execute: OptionalBooleanField(),
  })
  .transform(b => ({ userId: b.user_id, execute: b.execute === true }));

export type ConsolidateBody = z.infer<typeof ConsolidateBodySchema>;

export const DecayBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    /** Defaults to true — false means actually archive. */
    dry_run: OptionalBooleanField(),
  })
  .transform(b => ({ userId: b.user_id, dryRun: b.dry_run !== false }));

export type DecayBody = z.infer<typeof DecayBodySchema>;

export const ReconcileBodySchema = z
  .object({
    // user_id is genuinely optional on this route — empty string
    // behaves the same as absent (falls back to reconcileDeferredAll).
    user_id: OptionalBodyString,
  })
  .transform(b => ({
    userId: typeof b.user_id === 'string' && b.user_id.length > 0 ? b.user_id : undefined,
  }));

export type ReconcileBody = z.infer<typeof ReconcileBodySchema>;

export const ResetSourceBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    source_site: requiredStringBody('source_site'),
  })
  .transform(b => ({ userId: b.user_id, sourceSite: b.source_site }));

export type ResetSourceBody = z.infer<typeof ResetSourceBodySchema>;

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export const LessonReportBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    pattern: requiredStringBody('pattern'),
    source_memory_ids: z
      .unknown()
      .transform(v =>
        Array.isArray(v) && v.every((x: unknown) => typeof x === 'string')
          ? (v as string[])
          : [],
      )
      .openapi({ type: 'array', items: { type: 'string' } }),
    severity: z.unknown().optional(),
  })
  .transform(b => ({
    userId: b.user_id,
    pattern: b.pattern,
    sourceMemoryIds: Array.isArray(b.source_memory_ids) ? b.source_memory_ids : [],
    severity: b.severity,
  }));

export type LessonReportBody = z.infer<typeof LessonReportBodySchema>;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** requireQueryString: truthy + typeof string. Matches memories.ts:580-583. */
const RequiredQueryString = z.string().min(1);

export const UserIdQuerySchema = z
  .object({ user_id: RequiredQueryString })
  .transform(q => ({ userId: q.user_id }));

export type UserIdQuery = z.infer<typeof UserIdQuerySchema>;

/** Auto-converts limit to number with default; matches parseUserIdAndLimit. */
export const UserIdLimitQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    limit: z.string().optional(),
  })
  .transform(q => ({
    userId: q.user_id,
    limit: parseIntegerLimit(q.limit, 20),
  }));

export type UserIdLimitQuery = z.infer<typeof UserIdLimitQuerySchema>;

export const ListQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    limit: z.string().optional(),
    offset: z.string().optional(),
    workspace_id: OptionalQueryField(),
    agent_id: OptionalUuidQueryField('agent_id'),
    source_site: OptionalQueryField(),
    episode_id: OptionalUuidQueryField('episode_id'),
    session_id: SessionIdField,
  })
  .transform(q => ({
    userId: q.user_id,
    limit: parseIntegerLimit(q.limit, 20),
    offset: parseIntegerLimit(q.offset, 0),
    workspaceId: q.workspace_id,
    agentId: q.agent_id,
    sourceSite: q.source_site,
    episodeId: q.episode_id,
    sessionId: q.session_id,
  }))
  .refine(q => !(q.workspaceId && !q.agentId), {
    message: 'agent_id is required for workspace queries',
  });

export type ListQuery = z.infer<typeof ListQuerySchema>;

/** Used by GET /:id and DELETE /:id. Same workspace-requires-agent rule. */
export const MemoryByIdQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    workspace_id: OptionalQueryField(),
    agent_id: OptionalUuidQueryField('agent_id'),
  })
  .transform(q => ({
    userId: q.user_id,
    workspaceId: q.workspace_id,
    agentId: q.agent_id,
  }))
  .refine(q => !(q.workspaceId && !q.agentId), {
    message: 'agent_id is required for workspace queries',
  });

export type MemoryByIdQuery = z.infer<typeof MemoryByIdQuerySchema>;

/**
 * Anti-amplification cap for `GET /v1/memories/event-chains`. The endpoint
 * fans out per entity (one chain hydration each); without an upper bound a
 * single request can pull tens of thousands of rows.
 */
const MAX_ENTITY_IDS_PER_REQUEST = 100;

/**
 * Query for `GET /v1/memories/event-chains`. Accepts a comma-separated list
 * of entity UUIDs and returns the per-entity ordered event chain.
 * `entity_ids` is parsed as comma-separated, trimmed, deduplicated; empty
 * tokens skipped. At least one valid UUID required, capped at
 * MAX_ENTITY_IDS_PER_REQUEST entries.
 */
export const EventChainsQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    entity_ids: RequiredQueryString,
  })
  .transform(q => {
    const ids = [...new Set(
      q.entity_ids
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0),
    )];
    return { userId: q.user_id, entityIds: ids };
  })
  .refine(q => q.entityIds.length > 0, {
    message: 'entity_ids must contain at least one non-empty value',
  })
  .refine(q => q.entityIds.length <= MAX_ENTITY_IDS_PER_REQUEST, {
    message: `entity_ids must contain at most ${MAX_ENTITY_IDS_PER_REQUEST} values`,
  })
  .refine(q => q.entityIds.every(id => UUID_REGEX.test(id)), {
    message: 'entity_ids entries must be valid UUIDs',
  });

export type EventChainsQuery = z.infer<typeof EventChainsQuerySchema>;

/**
 * Body for `POST /v1/memories/first-mentions/extract`. Accepts the full
 * conversation transcript plus a turn-id-to-memory-id mapping (the harness
 * provides this — the in-core ingest pipeline does not retain turn
 * structure). The service runs a single LLM call to identify chronological
 * topic-introduction events and persists them.
 */
export const FirstMentionsExtractBodySchema = z
  .object({
    user_id: z.string().min(1),
    conversation_text: z.string().min(1).max(MAX_CONVERSATION_LENGTH),
    source_site: z.string().min(1),
    // Values must be UUIDs — they're inserted into a UUID column
    // (`first_mention_events.memory_id`). Validate at the schema layer so a
    // bad value returns 400 instead of leaking a Postgres "invalid input
    // syntax for type uuid" error as a 500.
    memory_ids_by_turn_id: z.record(z.string(), z.string().uuid()),
  })
  .transform(b => {
    const map = new Map<number, string>();
    for (const [k, v] of Object.entries(b.memory_ids_by_turn_id)) {
      const n = Number(k);
      if (Number.isFinite(n) && Number.isInteger(n)) map.set(n, v);
    }
    return {
      userId: b.user_id,
      conversationText: b.conversation_text,
      sourceSite: b.source_site,
      memoryIdsByTurnId: map,
    };
  });

export type FirstMentionsExtractBody = z.infer<typeof FirstMentionsExtractBodySchema>;

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const UuidIdParamSchema = makeUuidPathParamSchema();

export type UuidIdParam = z.infer<typeof UuidIdParamSchema>;

/** Non-UUID :id used by DELETE /lessons/:id (lessonId is a free string). */
export const FreeIdParamSchema = z
  .object({
    id: z.string().min(1),
  })
  .transform(p => ({ id: p.id }));

export type FreeIdParam = z.infer<typeof FreeIdParamSchema>;

// ---------------------------------------------------------------------------
// Config (PUT /config) — special case
// ---------------------------------------------------------------------------

/**
 * PUT /config body is intentionally loose: the handler enforces the
 * startup-only-fields + 410 checks. We expose the body as an open
 * object so the 410-first-check-then-reject-then-apply flow stays in
 * the handler where it belongs.
 */
export const ConfigBodySchema = z
  .object({})
  .passthrough()
  .openapi({ description: 'Runtime config mutation. See handler for 410 and rejected[] paths.' });

export type ConfigBody = z.infer<typeof ConfigBodySchema>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildWorkspaceContext(
  workspaceId: string | undefined,
  agentId: string | undefined,
  visibility: z.infer<typeof MemoryVisibilitySchema> | undefined,
): WorkspaceContext | undefined {
  if (!workspaceId || !agentId) return undefined;
  return { workspaceId, agentId, visibility };
}

/** parseInt with default. Non-numeric strings → NaN → handler falls back. */
function parseIntegerLimit(raw: string | undefined, defaultVal: number): number {
  return parseInt(String(raw ?? String(defaultVal)), 10);
}

function OptionalQueryField() {
  return z
    .unknown()
    .transform(v => (typeof v === 'string' && v.length > 0 ? v : undefined))
    .openapi({ type: 'string' });
}

function OptionalUuidQueryField(label: string) {
  return z
    .unknown()
    .transform(v => (typeof v === 'string' && v.length > 0 ? v : undefined))
    .refine(s => s === undefined || UUID_REGEX.test(s), {
      message: `${label} must be a valid UUID`,
    })
    .openapi({ type: 'string', format: 'uuid' });
}
