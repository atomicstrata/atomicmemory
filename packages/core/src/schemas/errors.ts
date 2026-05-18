/**
 * @file Zod schemas for HTTP error envelopes.
 *
 * The canonical envelope across the API is `{ error: string }`:
 *   - 400: emitted by the Zod `validateBody` / `validateQuery` /
 *     `validateParams` middleware in `src/middleware/validate.ts`
 *     when request input fails schema validation.
 *   - 500: emitted by `handleRouteError` in `src/routes/route-errors.ts`
 *     for uncaught service-layer exceptions.
 *
 * Two routes have richer envelopes:
 *   - `PUT /v1/memories/config` — 400 with `{ error, detail, rejected[] }`
 *     when startup-only fields are mutated at runtime.
 *   - `PUT /v1/memories/config` — 410 with `{ error, detail }` when
 *     runtime config mutation is disabled.
 *
 * Routes that call upstream AI providers can also emit a richer
 * envelope on 502 / 503 — see `ErrorUpstreamProviderSchema`.
 *
 * These schemas are the source of truth for the OpenAPI spec's response
 * components.
 */

import { z } from './zod-setup.js';

/** Standard error envelope used by every route for 400 (validation) and 500 (uncaught). */
export const ErrorBasicSchema = z
  .object({
    error: z.string(),
  })
  .openapi({
    description: 'Standard error envelope. 400 for input validation errors, 500 for uncaught exceptions.',
    example: { error: 'user_id is required' },
  });

export type ErrorBasic = z.infer<typeof ErrorBasicSchema>;

/**
 * Richer 400 envelope returned by `PUT /v1/memories/config` when a
 * request body includes startup-only fields that cannot be mutated at
 * runtime (embedding/LLM provider + model).
 */
export const ErrorConfig400Schema = z
  .object({
    error: z.string(),
    detail: z.string(),
    rejected: z.array(z.string()),
  })
  .openapi({
    description: 'Richer 400 envelope for PUT /v1/memories/config when startup-only fields are included.',
    example: {
      error: 'Provider/model selection is startup-only',
      detail: 'Fields embedding_provider cannot be mutated at runtime — the embedding/LLM provider caches are fixed at first use.',
      rejected: ['embedding_provider'],
    },
  });

export type ErrorConfig400 = z.infer<typeof ErrorConfig400Schema>;

/**
 * 410 envelope returned by `PUT /v1/memories/config` when runtime
 * config mutation is disabled (production default).
 */
export const ErrorConfig410Schema = z
  .object({
    error: z.string(),
    detail: z.string(),
  })
  .openapi({
    description: '410 Gone envelope for PUT /v1/memories/config when runtime mutation is disabled.',
    example: {
      error: 'PUT /v1/memories/config is deprecated for production',
      detail: 'Set CORE_RUNTIME_CONFIG_MUTATION_ENABLED=true to enable runtime mutation in dev/test environments.',
    },
  });

export type ErrorConfig410 = z.infer<typeof ErrorConfig410Schema>;

/**
 * Sanitized envelope emitted by `handleRouteError` when an upstream AI
 * provider (LLM or embedding) failure is classified by
 * `classifyUpstreamProviderFailure` in `src/routes/upstream-provider-errors.ts`.
 *
 *   - 502 Bad Gateway: provider auth (401/403) or non-retryable 4xx.
 *   - 503 Service Unavailable: provider rate limit / quota exhausted
 *     (429), or provider 5xx where retry is meaningful.
 *
 * `retryable` tells the caller whether a retry can succeed without
 * operator intervention. `details` is a length-capped string sanitized
 * of API keys and bearer tokens.
 */
export const ErrorUpstreamProviderSchema = z
  .object({
    error_code: z.enum([
      'upstream_provider_auth_failed',
      'upstream_provider_rate_limited',
      'upstream_provider_quota_exceeded',
      'upstream_provider_error',
    ]),
    error: z.string(),
    message: z.string(),
    provider_status: z.number().int(),
    retryable: z.boolean(),
    details: z.string(),
  })
  .openapi({
    description: 'Upstream AI provider failure envelope (502 / 503).',
    example: {
      error_code: 'upstream_provider_auth_failed',
      error: 'Upstream provider authentication failed',
      message:
        'The configured AI provider rejected the request credentials. Check the provider API key and account access.',
      provider_status: 401,
      retryable: false,
      details: 'Incorrect API key provided: [REDACTED_API_KEY].',
    },
  });

export type ErrorUpstreamProvider = z.infer<typeof ErrorUpstreamProviderSchema>;
