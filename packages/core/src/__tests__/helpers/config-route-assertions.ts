/**
 * @file Shared assertions for the `PUT /memories/config` and
 * `PUT /v1/memories/config` mutation routes.
 *
 * Both the route-seam test (`src/__tests__/memory-route-config-seam.test.ts`)
 * and the composed/reference parity test
 * (`src/app/__tests__/composed-boot-parity.test.ts`) verify that a
 * `max_search_results` mutation lands by checking the same three things:
 *   1. response status is 200,
 *   2. `applied` lists the field,
 *   3. the echoed `config.max_search_results` equals the value we sent.
 *
 * Extracted here so the two tests don't carry token-identical assertion
 * blocks. The helper is intentionally narrow: it does not perform the
 * `fetch(...)` itself, because callers compose different URLs / auth
 * headers / request bodies that fallow does not consider duplication.
 */

import { expect } from 'vitest';

interface AppliedConfigResponse {
  applied: string[];
  config: { max_search_results: number };
}

/**
 * Assert the response from `PUT …/memories/config` reflects a
 * `max_search_results = expectedValue` mutation. Awaits and consumes the
 * response body.
 */
export async function expectMaxSearchResultsApplied(
  putRes: Response,
  expectedValue: number,
): Promise<void> {
  expect(putRes.status).toBe(200);
  const putBody = (await putRes.json()) as AppliedConfigResponse;
  expect(putBody.applied).toContain('max_search_results');
  expect(putBody.config.max_search_results).toBe(expectedValue);
}
