/**
 * Negative-contract redaction tests for `formatStoredArtifact`.
 *
 * Plants secret-shaped fields in the raw row (provider_details with
 * `nonce`, `tag`, `private_key`; identifiers with `signed_proof`; the
 * internal `stored_hash` column) and asserts NONE of them reach the
 * wire after the public projection runs.
 *
 * `stored_hash` is the highest-priority leak — it identifies the
 * encoded bytes the adapter wrote and must never be exposed regardless
 * of `disclose_content_hash`. The plaintext `content_hash` follows the
 * caller opt-in.
 */

import { describe, expect, it } from 'vitest';
import type { StorageArtifactRow } from '../../db/storage-artifact-repository.js';
import { formatStoredArtifact } from '../../routes/storage-response-formatters.js';

function row(overrides: Partial<StorageArtifactRow> = {}): StorageArtifactRow {
  return {
    id: 'c0ffeeee-1111-4111-8111-111111111111',
    userId: 'redact-user',
    orgId: null,
    projectId: null,
    provider: 'local_fs',
    mode: 'managed',
    uri: 'file:///tmp/x',
    status: 'stored',
    sizeBytes: 11,
    contentType: 'text/plain',
    plaintextHash: 'plaintext-sha256-hex',
    storedHash: 'stored-sha256-hex',
    contentEncoding: 'identity',
    discloseContentHash: false,
    identifiers: { etag: 'safe', signed_proof: 'SECRET-PROOF' } as Record<string, unknown>,
    lifecycle: {},
    replication: null,
    verification: null,
    retrieval: null,
    providerDetails: {
      nonce: 'SECRET-NONCE',
      tag: 'SECRET-TAG',
      private_key: 'SECRET-KEY',
    } as Record<string, unknown>,
    metadata: { source: 'drive' },
    lastError: { code: 'internal-failure-detail' },
    putAttemptId: null,
    deleteAttemptId: 'attempt-id',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:01Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('formatStoredArtifact — negative-contract redaction', () => {
  it('strips internal columns (stored_hash, last_error, delete_attempt_id) from the wire', () => {
    const wire = formatStoredArtifact(row());
    const wireAsRecord = wire as unknown as Record<string, unknown>;
    expect(wireAsRecord).not.toHaveProperty('stored_hash');
    expect(wireAsRecord).not.toHaveProperty('plaintext_hash');
    expect(wireAsRecord).not.toHaveProperty('last_error');
    expect(wireAsRecord).not.toHaveProperty('delete_attempt_id');
  });

  it('omits content_hash when discloseContentHash=false (default)', () => {
    const wire = formatStoredArtifact(row({ discloseContentHash: false }));
    expect(wire).not.toHaveProperty('content_hash');
  });

  it('exposes plaintext content_hash only when discloseContentHash=true', () => {
    const wire = formatStoredArtifact(row({ discloseContentHash: true }));
    expect(wire.content_hash).toBe('plaintext-sha256-hex');
    expect(JSON.stringify(wire)).not.toContain('stored-sha256-hex');
  });

  it('drops secret-shaped fields from identifiers and provider_details', () => {
    const wire = formatStoredArtifact(row());
    // identifiers: signed_proof is NOT in the allowlist
    expect(JSON.stringify(wire.identifiers)).not.toContain('SECRET-PROOF');
    // local_fs identifier allowlist accepts `etag`.
    expect(wire.identifiers).toEqual({ etag: 'safe' });
    // provider_details: nonce / tag / private_key are NOT in any
    // provider allowlist. The formatter must omit them.
    expect(JSON.stringify(wire)).not.toContain('SECRET-NONCE');
    expect(JSON.stringify(wire)).not.toContain('SECRET-TAG');
    expect(JSON.stringify(wire)).not.toContain('SECRET-KEY');
    // No provider_details should be emitted at all for local_fs in
    // this case (the allowlist is empty).
    expect(wire).not.toHaveProperty('provider_details');
  });

  it('external_pointer provider is treated as unknown — empty allowlist', () => {
    // The pointer-artifact provider lives in
    // `db/storage-artifact-providers.ts` and has no entry in the
    // per-provider redaction allowlist. Test proves both
    // `identifiers` and `provider_details` come back as empty
    // objects — no accidental leak of caller-supplied keys.
    const wire = formatStoredArtifact(
      row({
        provider: 'external_pointer',
        mode: 'pointer',
        identifiers: { signed_proof: 'SECRET', etag: 'SAFE' } as Record<string, unknown>,
        providerDetails: { bucket: 'SECRET', private_key: 'SECRET' } as Record<string, unknown>,
      }),
    );
    expect(wire.identifiers).toEqual({});
    expect(wire).not.toHaveProperty('provider_details');
    expect(JSON.stringify(wire)).not.toContain('SECRET');
    expect(JSON.stringify(wire)).not.toContain('SAFE');
  });

  it('per-provider allowlists differ — s3 surfaces bucket/region, local_fs does not', () => {
    const s3Wire = formatStoredArtifact(
      row({
        provider: 's3',
        identifiers: { etag: 'e', versionId: 'v', signed_proof: 'SECRET' },
        providerDetails: { bucket: 'b', region: 'us-east-1', private_key: 'SECRET' },
      }),
    );
    expect(s3Wire.identifiers).toEqual({ etag: 'e', versionId: 'v' });
    expect(s3Wire.provider_details).toEqual({ bucket: 'b', region: 'us-east-1' });
    expect(JSON.stringify(s3Wire)).not.toContain('SECRET');
  });

  it('filecoin allowlist surfaces CIDs and emits NO provider_details', () => {
    const wire = formatStoredArtifact(
      row({
        provider: 'filecoin',
        identifiers: {
          ipfsCid: 'baf...cid',
          pieceCid: 'baf...piece',
          carRootCid: 'baf...car',
          dataSetId: 'ds-1',
          signed_proof: 'SECRET',
        },
        providerDetails: {
          network: 'mainnet',
          onramp: 'storacha',
          wallet_address: 'SECRET_WALLET',
          payment_rail: 'SECRET_RAIL',
          synapse_response: 'SECRET_RAW',
          raw_synapse_payload: 'SECRET_BLOB',
        },
      }),
    );
    expect(wire.identifiers).toEqual({
      ipfsCid: 'baf...cid',
      pieceCid: 'baf...piece',
      carRootCid: 'baf...car',
      dataSetId: 'ds-1',
    });
    // No provider_details on the wire for filecoin until the provider
    // supplies Synapse-shaped public fields.
    expect(wire).not.toHaveProperty('provider_details');
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('SECRET_WALLET');
    expect(serialized).not.toContain('SECRET_RAIL');
    expect(serialized).not.toContain('SECRET_RAW');
    expect(serialized).not.toContain('SECRET_BLOB');
    // Legacy network/onramp keys must also be gone.
    expect(serialized).not.toContain('mainnet');
    expect(serialized).not.toContain('storacha');
  });

  it('derives lifecycle by (provider, mode): managed local_fs reports immediate+delete', () => {
    const wire = formatStoredArtifact(row({ provider: 'local_fs', mode: 'managed' }));
    expect(wire.lifecycle).toEqual({ availability: 'immediate', deleteSemantics: 'delete' });
  });

  it('pointer-mode lifecycle reports availability=immediate without delete semantics', () => {
    const wire = formatStoredArtifact(row({ mode: 'pointer' }));
    expect(wire.lifecycle).toEqual({ availability: 'immediate' });
  });

  it('filecoin lifecycle reports delayed availability + tombstone delete semantics', () => {
    const wire = formatStoredArtifact(
      row({ provider: 'filecoin', mode: 'managed' }),
    );
    expect(wire.lifecycle).toEqual({ availability: 'delayed', deleteSemantics: 'tombstone' });
  });

  it('replication/verification/retrieval are surfaced when populated and dropped when absent', () => {
    const present = formatStoredArtifact(
      row({
        provider: 'filecoin',
        mode: 'managed',
        replication: { desiredCopies: 3, confirmedCopies: 2, internal_marker: 'SECRET' },
        verification: { providerProofStatus: 'verified', secret_proof: 'SECRET' },
        retrieval: { status: 'retrievable', lastCheckedAt: '2024-01-01T00:00:00Z' },
      }),
    );
    expect(present.replication).toEqual({ desiredCopies: 3, confirmedCopies: 2 });
    expect(present.verification).toEqual({ providerProofStatus: 'verified' });
    expect(present.retrieval).toEqual({
      status: 'retrievable',
      lastCheckedAt: '2024-01-01T00:00:00Z',
    });
    expect(JSON.stringify(present)).not.toContain('SECRET');
    const absent = formatStoredArtifact(row());
    expect(absent).not.toHaveProperty('replication');
    expect(absent).not.toHaveProperty('verification');
    expect(absent).not.toHaveProperty('retrieval');
  });
});
