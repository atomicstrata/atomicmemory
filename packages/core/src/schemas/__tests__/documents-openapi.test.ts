/**
 * @file Pins the OpenAPI shape of /v1/documents nullable request fields.
 *
 * Background: Phase 1 wire fields like `account_id`, `external_uri`,
 * `display_name`, etc. accept either a string OR an explicit `null`.
 * An earlier draft used `z.unknown()` + `.openapi({ type: 'string' })`,
 * which silently described the field as string-only and lied to clients
 * generated from the spec. This test asserts the generated component
 * type is the union `["string","null"]` so a future schema regression
 * can't quietly drop the null branch from the public API.
 *
 * Lives next to the registry that produces it so a maintainer touching
 * `src/schemas/documents.ts` sees this pin in the same change set.
 */

import { describe, it, expect } from 'vitest';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { buildRegistry } from '../openapi';

const NULLABLE_WIRE_FIELDS = [
  'account_id',
  'external_uri',
  'display_name',
  'mime_type',
  'content_hash',
  'provider_version',
] as const;

function generateOpenApiDoc() {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Test', version: '0.0.0' },
  });
}

describe('OpenAPI: /v1/documents register body', () => {
  const doc = generateOpenApiDoc();
  const registerBody = (doc.paths?.['/v1/documents']?.post as { requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, { type?: string | string[] }> } }> } })
    ?.requestBody?.content?.['application/json']?.schema;

  it('is registered as a POST endpoint with a JSON body', () => {
    expect(registerBody).toBeDefined();
    expect(registerBody?.properties).toBeDefined();
  });

  for (const field of NULLABLE_WIRE_FIELDS) {
    it(`exposes ${field} as string-or-null (not string-only)`, () => {
      const fieldType = registerBody?.properties?.[field]?.type;
      expect(fieldType).toEqual(['string', 'null']);
    });
  }
});
