/**
 * @file Express request validators built on Zod schemas.
 *
 * `validateBody` / `validateQuery` / `validateParams` replace the hand-
 * written `parseIngestBody` / `parseSearchBody` / `requireBodyString`
 * helpers that used to live in `src/routes/*`. On failure they emit
 * the existing 400 response envelope verbatim — `{ error: string }`
 * — so HTTP clients see no change. Zod's structured issues are
 * flattened into a single descriptive string via {@link formatZodIssues}
 * matching the style of the prior parsers' thrown messages.
 *
 * On success the parsed-and-transformed value replaces the original
 * `req.body` / `req.query` / `req.params` so handlers see camelCase
 * fields regardless of the snake_case wire format.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { z, ZodError, ZodIssue, ZodTypeAny } from 'zod';

/**
 * Flatten Zod issues into a single human-readable string.
 *
 * Example output:
 *   "user_id is required; conversation must be ≤ 100000 characters"
 *
 * The format mirrors the ad-hoc messages produced by the route
 * handlers' inline validators today, so clients that regex-match error
 * text continue to work.
 */
export function formatZodIssues(issues: ZodIssue[]): string {
  return issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function respond400(res: Response, error: ZodError): void {
  res.status(400).json({ error: formatZodIssues(error.issues) });
}

type Source = 'body' | 'query' | 'params';

function makeValidator<T extends ZodTypeAny>(
  schema: T,
  source: Source,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      respond400(res, result.error);
      return;
    }
    // Express 5 exposes `req.query` (and `req.params`) as getter-only
    // properties on Request.prototype — plain `req.query = ...`
    // silently no-ops. Define an own property to shadow the prototype
    // accessor so handlers see the parsed-and-transformed value.
    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}

/** Validate `req.body` against a Zod schema. */
export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return makeValidator(schema, 'body');
}

/** Validate `req.query` against a Zod schema. */
export function validateQuery<T extends ZodTypeAny>(schema: T): RequestHandler {
  return makeValidator(schema, 'query');
}

/** Validate `req.params` against a Zod schema. */
export function validateParams<T extends ZodTypeAny>(schema: T): RequestHandler {
  return makeValidator(schema, 'params');
}

/**
 * Assert that a response payload matches `schema`, throwing in non-
 * production. Used as a lightweight runtime contract check on handler
 * outputs; in production it is a no-op so there is no perf impact.
 *
 * Callers should invoke `assertResponse(Schema, payload)` immediately
 * before `res.json(payload)` on non-trivial routes.
 */
export function assertResponse<T extends ZodTypeAny>(
  schema: T,
  payload: unknown,
): asserts payload is z.infer<T> {
  if (process.env.NODE_ENV === 'production') return;
  const result = schema.safeParse(payload);
  if (result.success) return;
  const message = formatZodIssues(result.error.issues);
  throw new Error(`[assertResponse] payload failed schema: ${message}`);
}
