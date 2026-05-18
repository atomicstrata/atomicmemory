/**
 * Unit tests for supplemental extraction coverage merging.
 */

import { describe, expect, it } from 'vitest';
import { mergeSupplementalFacts } from '../supplemental-extraction.js';
import type { ExtractedFact } from '../extraction.js';

function baseFact(overrides: Partial<ExtractedFact>): ExtractedFact {
  return {
    fact: 'As of January 2026, user is using Tailwind CSS.',
    headline: 'Uses Tailwind CSS',
    importance: 0.6,
    type: 'project',
    keywords: ['Tailwind CSS'],
    entities: [{ name: 'Tailwind CSS', type: 'tool' }],
    relations: [{ source: 'User', target: 'Tailwind CSS', type: 'uses' }],
    ...overrides,
  };
}

describe('mergeSupplementalFacts', () => {
  it('adds missing supplemental facts with new entities', () => {
    const merged = mergeSupplementalFacts(
      [],
      '[Session date: 2026-01-22]\nUser: Quick update on the finance tracker. I added Plaid integration for bank account syncing.',
    );

    expect(merged.some((fact) => fact.fact.includes('Plaid integration'))).toBe(true);
  });

  it('keeps supplemental temporal detail when base fact lacks it', () => {
    const merged = mergeSupplementalFacts(
      [baseFact({ fact: 'As of January 15 2026, user is using Tailwind CSS for styling in the finance tracker project.' })],
      "[Session date: 2026-01-15]\nUser: Tailwind CSS. I've been using it for the last year and can't go back to regular CSS.",
    );

    expect(merged.some((fact) => fact.fact.includes('last year'))).toBe(true);
  });

  it('keeps supplemental relative-date facts for Cat2 timing questions', () => {
    const merged = mergeSupplementalFacts(
      [baseFact({ fact: 'As of January 20 2023, user lost a job.' })],
      '[Session date: 2023-01-20]\nUser: Lost my job as a banker yesterday. Unfortunately I also lost my job at Door Dash this month.',
    );

    expect(merged.some((fact) => fact.fact.includes('yesterday (on January 19, 2023)'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('this month (in January 2023)'))).toBe(true);
  });

  it('does not duplicate identical facts', () => {
    const primary = baseFact({
      fact: 'As of January 22 2026, user added Plaid integration for bank account syncing.',
      headline: 'Added Plaid integration',
      keywords: ['Plaid'],
      entities: [{ name: 'Plaid', type: 'tool' }],
      relations: [{ source: 'User', target: 'Plaid', type: 'uses' }],
    });

    const merged = mergeSupplementalFacts(
      [primary],
      '[Session date: 2026-01-22]\nUser: I added Plaid integration for bank account syncing.',
    );

    expect(merged).toHaveLength(1);
  });

  it('upgrades shorter primary facts when supplemental coverage adds project context', () => {
    const primary = baseFact({
      fact: 'As of January 22 2026, user added Plaid integration for bank account syncing.',
      headline: 'Added Plaid integration',
      keywords: ['Plaid'],
      entities: [
        { name: 'User', type: 'person' },
        { name: 'Plaid', type: 'tool' },
      ],
      relations: [{ source: 'User', target: 'Plaid', type: 'uses' }],
    });

    const merged = mergeSupplementalFacts(
      [primary],
      '[Session date: 2026-01-22]\nUser: Quick update on the finance tracker. I added Plaid integration for bank account syncing.',
    );

    expect(merged.some((fact) => fact.fact.includes('finance tracker. I added Plaid integration'))).toBe(true);
    expect(merged.some((fact) => fact.fact === primary.fact)).toBe(false);
  });

  it('keeps literal-detail supplemental facts even without non-user entities', () => {
    const merged = mergeSupplementalFacts(
      [],
      '[Session date: 2023-02-01]\nUser: My necklace from grandma symbolizes love, faith, and strength. I found the perfect spot for my clothing store and designed the space, furniture, and decor.',
    );

    expect(merged.some((fact) => fact.fact.includes('necklace from grandma symbolizes love, faith, and strength'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('perfect spot for my clothing store'))).toBe(true);
  });

  it('keeps quoted literal facts that the primary extractor often drops', () => {
    const merged = mergeSupplementalFacts(
      [],
      '[Session date: 2023-09-13]\nUser: The posters at the poetry reading said "Trans Lives Matter".',
    );

    expect(merged.some((fact) => fact.fact.includes('"Trans Lives Matter"'))).toBe(true);
  });

  it('keeps late-timeline event facts even when they have no non-user entities', () => {
    const merged = mergeSupplementalFacts(
      [baseFact({ fact: 'As of July 21 2023, user is working on a business.' })],
      [
        '[Session date: 2023-07-21]',
        'Jon: Started to learn all these marketing and analytics tools to push the biz forward today.',
        'Gina: Let\'s create some cool content and manage your social media accounts.',
      ].join('\n'),
    );

    expect(merged.some((fact) => fact.fact.includes('analytics tools'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('social media accounts'))).toBe(true);
  });

  it('keeps LoCoMo temporal duration and doctor facts without named entities', () => {
    const merged = mergeSupplementalFacts(
      [],
      [
        '[Session date: 2023-05-24]',
        'Nate: I like having some of these little turtles around to keep me calm.',
        "Nate: I've had them for 3 years now and they bring me tons of joy!",
        "Sam: Thanks, Evan. Appreciate the offer, but had a check-up with my doctor a few days ago and, yikes, the weight wasn't great.",
      ].join('\n'),
    );

    expect(merged.some((fact) => fact.fact.includes('Nate has had the turtles for 3 years now'))).toBe(true);
    expect(merged.some((fact) => fact.fact.includes('Sam had a check-up with Sam\'s doctor a few days ago'))).toBe(true);
  });
});
