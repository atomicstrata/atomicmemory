/**
 * Unit tests for deterministic relation-backed claim slot derivation.
 */

import { describe, expect, it } from 'vitest';
import { buildRelationClaimSlot, type CanonicalEntityRef } from '../claim-slotting.js';

describe('buildRelationClaimSlot', () => {
  it('builds a stable slot from canonical relation endpoints', () => {
    const canonical = new Map<string, CanonicalEntityRef>([
      ['jake', {
        extractedName: 'Jake',
        entityId: 'person-jake',
        canonicalName: 'Jake',
        entityType: 'person',
      }],
      ['openai', {
        extractedName: 'OpenAI',
        entityId: 'org-openai',
        canonicalName: 'OpenAI',
        entityType: 'organization',
      }],
    ]);

    const slot = buildRelationClaimSlot([{
      source: 'Jake',
      target: 'OpenAI',
      type: 'works_at',
    }], canonical);

    expect(slot).toEqual({
      slotKey: 'relation:person-jake:works_at:org-openai',
      subjectEntityId: 'person-jake',
      relationType: 'works_at',
      objectEntityId: 'org-openai',
    });
  });

  it('returns null when a relation endpoint is not canonically resolved', () => {
    const canonical = new Map<string, CanonicalEntityRef>([
      ['jake', {
        extractedName: 'Jake',
        entityId: 'person-jake',
        canonicalName: 'Jake',
        entityType: 'person',
      }],
    ]);

    const slot = buildRelationClaimSlot([{
      source: 'Jake',
      target: 'OpenAI',
      type: 'works_at',
    }], canonical);

    expect(slot).toBeNull();
  });
});
