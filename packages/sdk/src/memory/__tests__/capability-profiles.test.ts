/**
 * @file Capability-profile tests
 *
 * Verifies that the real AtomicMemoryProvider satisfies a sample
 * capability profile, and that deliberately-deficient capability objects are
 * rejected with an actionable gap diff naming the missing requirement.
 */

import { describe, it, expect } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import { satisfiesProfile, capabilityGaps, type CapabilityProfile } from '../capability-profiles';
import type { Capabilities } from '../types';

// Sample profile: an audited ingest->search->replay path needs deterministic
// verbatim storage plus liveness (health) and version pinning (versioning).
const AUDITED_PATH_PROFILE: CapabilityProfile = {
  ingestModes: ['text', 'verbatim'],
  extensions: ['health', 'versioning'],
};

function eligibleCapabilities(): Capabilities {
  return {
    ingestModes: ['text', 'messages', 'verbatim'],
    requiredScope: { default: ['user'] },
    extensions: {
      update: false,
      package: false,
      temporal: false,
      graph: false,
      forget: false,
      profile: false,
      reflect: false,
      versioning: true,
      batch: false,
      health: true,
    },
  };
}

describe('capabilityGaps / satisfiesProfile', () => {
  it('accepts a provider that satisfies the profile', () => {
    const provider = new AtomicMemoryProvider({ apiUrl: 'https://example.invalid' });
    const caps = provider.capabilities();

    expect(satisfiesProfile(caps, AUDITED_PATH_PROFILE)).toBe(true);
    expect(capabilityGaps(caps, AUDITED_PATH_PROFILE)).toEqual([]);
  });

  it('rejects a provider missing a required extension and names the gap', () => {
    const caps = eligibleCapabilities();
    caps.extensions.versioning = false;

    expect(satisfiesProfile(caps, AUDITED_PATH_PROFILE)).toBe(false);
    const gaps = capabilityGaps(caps, AUDITED_PATH_PROFILE);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'extension', requirement: 'versioning' });
  });

  it('rejects a provider without a required ingest mode and names the gap', () => {
    const caps = eligibleCapabilities();
    caps.ingestModes = ['text', 'messages'];

    expect(satisfiesProfile(caps, AUDITED_PATH_PROFILE)).toBe(false);
    const gaps = capabilityGaps(caps, AUDITED_PATH_PROFILE);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'ingestMode', requirement: 'verbatim' });
  });

  it('reports every gap when multiple requirements are unmet', () => {
    const caps = eligibleCapabilities();
    caps.ingestModes = ['messages'];
    caps.extensions.health = false;
    caps.extensions.versioning = false;

    const gaps = capabilityGaps(caps, AUDITED_PATH_PROFILE);
    const requirements = gaps.map((gap) => gap.requirement).sort();
    expect(requirements).toEqual(['health', 'text', 'verbatim', 'versioning']);
  });
});
