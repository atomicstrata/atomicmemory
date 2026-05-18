/**
 * Unit tests for deterministic entity/relation enrichment on extracted facts.
 */

import { describe, expect, it } from 'vitest';
import { enrichExtractedFact } from '../extraction-enrichment.js';
import type { ExtractedFact } from '../extraction.js';

describe('enrichExtractedFact', () => {
  it('adds a self entity and uses relation for tool timeline facts', () => {
    const fact = buildFact(
      'As of January 15 2026, user has been using Tailwind CSS for the last year.',
      ['Tailwind CSS'],
    );

    const enriched = enrichExtractedFact(fact);

    expect(enriched.entities).toEqual(expect.arrayContaining([
      { name: 'User', type: 'person' },
      { name: 'Tailwind CSS', type: 'tool' },
    ]));
    expect(enriched.relations).toContainEqual({
      source: 'User',
      target: 'Tailwind CSS',
      type: 'uses',
    });
  });

  it('adds advisor and organization relations for advisor timeline facts', () => {
    const fact = buildFact(
      'As of February 15 2026, user got some career advice from Dr. Chen at MSR.',
      ['Dr. Chen', 'MSR'],
    );

    const enriched = enrichExtractedFact(fact);

    expect(enriched.entities).toEqual(expect.arrayContaining([
      { name: 'User', type: 'person' },
      { name: 'Dr. Chen', type: 'person' },
      { name: 'Microsoft Research', type: 'organization' },
    ]));
    expect(enriched.relations).toEqual(expect.arrayContaining([
      { source: 'User', target: 'Dr. Chen', type: 'knows' },
      { source: 'Dr. Chen', target: 'Microsoft Research', type: 'works_at' },
    ]));
  });

  it('adds project-tool relations for integration facts', () => {
    const fact = buildFact(
      'As of January 22 2026, user added Plaid integration for bank account syncing in the finance tracker.',
      ['Plaid', 'finance tracker'],
    );

    const enriched = enrichExtractedFact(fact);

    expect(enriched.entities).toEqual(expect.arrayContaining([
      { name: 'User', type: 'person' },
      { name: 'Plaid', type: 'tool' },
      { name: 'finance tracker', type: 'project' },
    ]));
    expect(enriched.relations).toEqual(expect.arrayContaining([
      { source: 'User', target: 'Plaid', type: 'uses' },
      { source: 'finance tracker', target: 'Plaid', type: 'uses' },
    ]));
  });
});

function buildFact(factText: string, keywords: string[]): ExtractedFact {
  return {
    fact: factText,
    headline: factText.slice(0, 30),
    importance: 0.7,
    type: 'knowledge',
    keywords,
    entities: [],
    relations: [],
  };
}
