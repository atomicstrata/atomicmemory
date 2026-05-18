/**
 * @file Unit tests for HTTP error envelope schemas.
 *
 * Pins the exact shapes emitted by `handleRouteError` (route-errors.ts:19)
 * and the two special `PUT /v1/memories/config` error paths
 * (memories.ts:269-282). Phase 4's OpenAPI generator consumes these
 * schemas to produce the response components; failing shapes here
 * would quietly produce wrong spec downstream.
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorBasicSchema,
  ErrorConfig400Schema,
  ErrorConfig410Schema,
  ErrorUpstreamProviderSchema,
} from '../errors';

describe('ErrorBasicSchema', () => {
  it('accepts { error: string }', () => {
    expect(ErrorBasicSchema.safeParse({ error: 'bad' }).success).toBe(true);
  });

  it('rejects missing error', () => {
    expect(ErrorBasicSchema.safeParse({}).success).toBe(false);
  });

  it('rejects non-string error', () => {
    expect(ErrorBasicSchema.safeParse({ error: 42 }).success).toBe(false);
  });
});

describe('ErrorConfig400Schema', () => {
  it('accepts { error, detail, rejected: string[] }', () => {
    const ok = ErrorConfig400Schema.safeParse({
      error: 'Provider/model selection is startup-only',
      detail: 'Fields embedding_provider cannot be mutated at runtime',
      rejected: ['embedding_provider'],
    });
    expect(ok.success).toBe(true);
  });

  it('requires rejected to be present', () => {
    expect(
      ErrorConfig400Schema.safeParse({ error: 'x', detail: 'y' }).success,
    ).toBe(false);
  });
});

describe('ErrorConfig410Schema', () => {
  it('accepts { error, detail }', () => {
    expect(
      ErrorConfig410Schema.safeParse({ error: 'x', detail: 'y' }).success,
    ).toBe(true);
  });

  it('rejects missing detail', () => {
    expect(ErrorConfig410Schema.safeParse({ error: 'x' }).success).toBe(false);
  });
});

describe('ErrorUpstreamProviderSchema', () => {
  const valid = {
    error_code: 'upstream_provider_auth_failed' as const,
    error: 'Upstream provider authentication failed',
    message: 'msg',
    provider_status: 401,
    retryable: false,
    details: 'sanitized',
  };

  it('accepts the full upstream-failure envelope', () => {
    expect(ErrorUpstreamProviderSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    'upstream_provider_rate_limited',
    'upstream_provider_quota_exceeded',
    'upstream_provider_error',
  ])('accepts error_code %s', (code) => {
    expect(
      ErrorUpstreamProviderSchema.safeParse({ ...valid, error_code: code })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown error_code', () => {
    expect(
      ErrorUpstreamProviderSchema.safeParse({
        ...valid,
        error_code: 'something_else',
      }).success,
    ).toBe(false);
  });

  it('requires provider_status to be an integer', () => {
    expect(
      ErrorUpstreamProviderSchema.safeParse({
        ...valid,
        provider_status: 401.5,
      }).success,
    ).toBe(false);
  });
});
