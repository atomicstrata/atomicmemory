/**
 * Unit tests for deterministic quoted-entity extraction.
 *
 * Guards exact quoted titles and performer/event facts used by benchmark
 * extraction-normalization experiments.
 */

import { describe, expect, it } from 'vitest';
import { extractQuotedEntityFacts, mergeQuotedEntityFacts } from '../quoted-entity-extraction.js';
import type { ExtractedFact } from '../extraction.js';

function baseFact(fact: string): ExtractedFact {
  return {
    fact,
    headline: fact,
    importance: 0.6,
    type: 'knowledge',
    keywords: [],
    entities: [],
    relations: [],
  };
}

describe('extractQuotedEntityFacts', () => {
  it('extracts exact quoted book titles with speaker and session date', () => {
    const facts = extractQuotedEntityFacts(
      '[Session date: 2023-07-06]\nMelanie: I loved reading "Charlotte\'s Web" as a kid.',
    );

    expect(facts.map((fact) => fact.fact)).toContain(
      'As of July 6 2023, Melanie read "Charlotte\'s Web".',
    );
  });

  it('extracts leading quoted performer names as seen music events', () => {
    const facts = extractQuotedEntityFacts(
      '[Session date: 2023-09-20]\nMelanie: "Summer Sounds"- The playing an awesome pop song got everyone dancing and singing.',
    );

    expect(facts.map((fact) => fact.fact)).toContain(
      'As of September 20 2023, Melanie saw "Summer Sounds" perform music.',
    );
  });

  it('extracts named concert performers from event facts', () => {
    const facts = extractQuotedEntityFacts(
      "[Session date: 2023-08-14]\nMelanie: We celebrated my daughter's birthday at a Matt Patterson concert.",
    );

    expect(facts.map((fact) => fact.fact)).toContain(
      'As of August 14 2023, Melanie saw "Matt Patterson" perform music.',
    );
  });

  it('does not treat quoted song preferences as seen-live events', () => {
    const facts = extractQuotedEntityFacts(
      '[Session date: 2023-08-14]\nMelanie: I enjoy Ed Sheeran song "Perfect".',
    );

    expect(facts.map((fact) => fact.fact)).not.toContain(
      'As of August 14 2023, Melanie saw "Perfect" perform music.',
    );
  });

  it('extracts pronoun-linked recommendation letter writers', () => {
    const facts = extractQuotedEntityFacts(
      "[Session date: 2026-01-20]\nuser: My advisor Dr. Chen at MSR has been really supportive. She's writing my main recommendation letter.",
    );

    expect(facts.map((fact) => fact.fact)).toContain(
      "As of January 20 2026, Dr. Chen is writing user's main recommendation letter.",
    );
  });
});

describe('mergeQuotedEntityFacts', () => {
  it('adds clearer event facts alongside weak existing title mentions', () => {
    const merged = mergeQuotedEntityFacts(
      [baseFact('"Summer Sounds"- The playing an awesome pop song got everyone dancing.')],
      '[Session date: 2023-09-20]\nMelanie: "Summer Sounds"- The playing an awesome pop song got everyone dancing.',
    );

    expect(merged.map((fact) => fact.fact)).toContain(
      'As of September 20 2023, Melanie saw "Summer Sounds" perform music.',
    );
  });
});
