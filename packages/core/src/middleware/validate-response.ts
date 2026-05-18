/**
 * @file Dev/test-mode response validator.
 *
 * Wraps `res.json()` to parse the outgoing body against a route→schema
 * map declared alongside the OpenAPI response schemas. Catches the
 * formatter↔schema drift that `check:openapi` alone can't see: if a
 * formatter in `routes/memory-response-formatters.ts` changes a field
 * name or shape without the corresponding update in
 * `schemas/responses.ts`, tests fail loudly at the point of emission.
 *
 * No-op in production. Enabled by default everywhere else (tests,
 * `NODE_ENV=development`) so the check is on in the only environments
 * that actually run tests or local dev.
 *
 * Route keys follow Express's router-relative `${method} ${route.path}`
 * format (e.g. `post /ingest`, `get /:id`). `req.route.path` is set by
 * the time `res.json()` is called inside the handler, so the lookup
 * resolves correctly even for parameterized paths.
 *
 * Error-path responses (4xx/5xx) are not validated — each route emits
 * its own error envelope that's already schema-checked by the
 * `validateBody` middleware on the way in, and runtime error shapes
 * are intentionally less strict than success bodies.
 */

import type { RequestHandler } from 'express';
import type { z } from 'zod';

export type ResponseSchemaMap = Record<string, z.ZodTypeAny>;

/**
 * Build a middleware that validates 2xx JSON response bodies against
 * the supplied schema map. Returns a pass-through no-op when
 * NODE_ENV is `production`, so prod has zero per-request cost.
 */
export function validateResponse(schemaMap: ResponseSchemaMap): RequestHandler {
  if (process.env.NODE_ENV === 'production') {
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body: unknown) {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.route?.path) {
        const key = `${req.method.toLowerCase()} ${req.route.path}`;
        const schema = schemaMap[key];
        if (schema) {
          const result = schema.safeParse(body);
          if (!result.success) {
            throw new Error(
              `Response body for ${key} violates declared schema.\n`
                + `Formatter output does not match ${key}'s OpenAPI response schema. `
                + `Either update the formatter, or if the change is intentional, update `
                + `src/schemas/responses.ts and regenerate the OpenAPI spec.\n`
                + `Zod issues:\n${JSON.stringify(result.error.issues, null, 2)}`,
            );
          }
        }
      }
      return originalJson(body);
    };
    next();
  };
}
