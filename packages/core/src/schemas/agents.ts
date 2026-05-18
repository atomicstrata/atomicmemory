/**
 * @file Zod schemas for the 5 /v1/agents/* routes.
 *
 * Mirrors the inline parsers at `src/routes/agents.ts:86-109`
 * byte-for-byte:
 *   - `requireString` accepts either a string OR an array (takes
 *     first element via `String(value[0])`) — this handles Express
 *     query strings with duplicate params. Throws
 *     `"${field} is required"` on missing/non-accepted input.
 *   - `requireTrustLevel` distinguishes type error ("trust_level must
 *     be a number between 0.0 and 1.0") from range error
 *     ("trust_level must be between 0.0 and 1.0").
 *   - `requireResolution` accepts the three enum variants; anything
 *     else throws the full list-of-valid-values message.
 *
 * Every error message matches the pre-refactor text exactly so HTTP
 * clients that regex on `{ error }` continue to match.
 */

import { z } from './zod-setup.js';

/**
 * Build a schema that produces `"${label} is required"` for every
 * failure mode the old `requireString` threw on (missing, null,
 * non-string non-array, empty string, empty array). Successful
 * strings pass through; arrays yield `String(value[0])`.
 */
function requiredStringOrArray(label: string) {
  const message = `${label} is required`;
  return z
    .unknown()
    .transform(v => {
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && v.length > 0) return String(v[0]);
      return undefined;
    })
    .refine((v): v is string => typeof v === 'string' && v.length > 0, {
      message,
    })
    .transform(v => v as string)
    .openapi({ type: 'string', minLength: 1, description: `Required. ${label}.` });
}

const TRUST_TYPE_MESSAGE = 'trust_level must be a number between 0.0 and 1.0';
const TRUST_RANGE_MESSAGE = 'trust_level must be between 0.0 and 1.0';

/** Finite number in [0.0, 1.0]. Separate messages for wrong-type vs out-of-range. */
const TrustLevelSchema = z
  .unknown()
  .superRefine((v, ctx) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      ctx.addIssue({ code: 'custom', message: TRUST_TYPE_MESSAGE });
      return;
    }
    if (v < 0.0 || v > 1.0) {
      ctx.addIssue({ code: 'custom', message: TRUST_RANGE_MESSAGE });
    }
  })
  .transform(v => v as number)
  .openapi({
    type: 'number',
    minimum: 0.0,
    maximum: 1.0,
    description: 'Trust score in [0.0, 1.0].',
  });

const VALID_RESOLUTIONS = ['resolved_new', 'resolved_existing', 'resolved_both'] as const;
type Resolution = typeof VALID_RESOLUTIONS[number];

const RESOLUTION_MESSAGE =
  'resolution must be "resolved_new", "resolved_existing", or "resolved_both"';

const ResolutionSchema = z
  .unknown()
  .refine(
    (v): v is Resolution =>
      typeof v === 'string' && (VALID_RESOLUTIONS as readonly string[]).includes(v),
    { message: RESOLUTION_MESSAGE },
  )
  .transform(v => v as Resolution)
  .openapi({
    type: 'string',
    enum: [...VALID_RESOLUTIONS],
  });

// ---------------------------------------------------------------------------
// PUT /trust
// ---------------------------------------------------------------------------

export const SetTrustBodySchema = z
  .object({
    agent_id: requiredStringOrArray('agent_id'),
    user_id: requiredStringOrArray('user_id'),
    trust_level: TrustLevelSchema,
    display_name: z
      .unknown()
      .transform(v => (typeof v === 'string' ? v : undefined))
      .openapi({ type: 'string' }),
  })
  .transform(b => ({
    agentId: b.agent_id,
    userId: b.user_id,
    trustLevel: b.trust_level,
    displayName: b.display_name,
  }))
  .openapi({
    description:
      "Set the calling user's trust level for a given agent. trust_level in [0.0, 1.0].",
  });

export type SetTrustBody = z.infer<typeof SetTrustBodySchema>;

// ---------------------------------------------------------------------------
// GET /trust
// ---------------------------------------------------------------------------

export const GetTrustQuerySchema = z
  .object({
    agent_id: requiredStringOrArray('agent_id'),
    user_id: requiredStringOrArray('user_id'),
  })
  .transform(q => ({ agentId: q.agent_id, userId: q.user_id }))
  .openapi({ description: 'Look up the trust level for a (user, agent) pair.' });

export type GetTrustQuery = z.infer<typeof GetTrustQuerySchema>;

// ---------------------------------------------------------------------------
// GET /conflicts  +  POST /conflicts/auto-resolve
// ---------------------------------------------------------------------------

export const UserIdFromQuerySchema = z
  .object({ user_id: requiredStringOrArray('user_id') })
  .transform(q => ({ userId: q.user_id }))
  .openapi({ description: 'List open agent conflicts for a user.' });

export type UserIdFromQuery = z.infer<typeof UserIdFromQuerySchema>;

export const UserIdFromBodySchema = z
  .object({ user_id: requiredStringOrArray('user_id') })
  .transform(b => ({ userId: b.user_id }))
  .openapi({ description: 'Auto-resolve expired conflicts for a user.' });

export type UserIdFromBody = z.infer<typeof UserIdFromBodySchema>;

// ---------------------------------------------------------------------------
// PUT /conflicts/:id/resolve
// ---------------------------------------------------------------------------

export const ConflictIdParamSchema = z
  .object({ id: z.string().min(1) })
  .transform(p => ({ id: p.id }));

export type ConflictIdParam = z.infer<typeof ConflictIdParamSchema>;

export const ResolveConflictBodySchema = z
  .object({ resolution: ResolutionSchema })
  .transform(b => ({ resolution: b.resolution }))
  .openapi({ description: 'Resolve a specific conflict with one of the three enum variants.' });

export type ResolveConflictBody = z.infer<typeof ResolveConflictBodySchema>;
