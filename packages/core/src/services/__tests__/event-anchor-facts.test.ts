/**
 * Integration coverage for extraction-time event-anchor fact generation.
 */

import { describe, expect, it } from 'vitest';
import { quickExtractFacts } from '../quick-extraction.js';

describe('event anchor facts', () => {
  it('emits mentorship.received anchors from relative-time facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-16]',
      'Jon: Gina, you won\'t believe it - I got mentored by this amazing business dude yesterday!',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor mentorship.received'));
    expect(anchor?.fact).toContain('for Jon');
    expect(anchor?.fact).toContain('occurred on June 15, 2023');
  });

  it('emits networking.first_visit anchors from speaker-labeled turns', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-21]',
      'Jon: That\'s awesome, Gina! Yesterday I chose to go to networking events to make things happen.',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor networking.first_visit'));
    expect(anchor?.fact).toContain('occurred on June 20, 2023');
  });

  it('emits internship.accepted anchors for accepted-role facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-05-27]',
      'Gina: Hey Jon! Long time no talk! A lot\'s happened - I just got accepted for a fashion internship!',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor internship.accepted'));
    expect(anchor?.fact).toContain('occurred on May 27, 2023');
  });

  it('emits trip.paris anchors from relative travel facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-01-29]',
      'Jon: Oh, I\'ve been to Paris yesterday! It was sooo cool.',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor trip.paris'));
    expect(anchor?.fact).toContain('for Jon');
    expect(anchor?.fact).toContain('occurred on January 28, 2023');
  });

  it('emits trip.rome anchors from short-trip facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-16]',
      'Jon: Took a short trip last week to Rome to clear my mind a little.',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor trip.rome'));
    expect(anchor?.fact).toContain('for Jon');
    expect(anchor?.fact).toContain('occurred on June 9, 2023');
    expect(facts.some((fact) => fact.fact.includes('event anchor trip.took_short_trip_rome'))).toBe(true);
  });
});
