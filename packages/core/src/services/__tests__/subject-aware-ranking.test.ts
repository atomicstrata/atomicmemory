/**
 * Unit tests for subject-aware reranking on person-specific queries.
 */

import { describe, expect, it } from 'vitest';
import { applySubjectAwareRanking, extractSubjectQueryAnchors } from '../subject-aware-ranking.js';
import { createSearchResult } from './test-fixtures.js';

function buildResult(id: string, content: string, score: number) {
  return createSearchResult({
    id, content, user_id: 'u1', memory_type: 'fact', network: 'experience',
    created_at: new Date('2023-01-20T00:00:00.000Z'),
    last_accessed_at: new Date('2023-01-20T00:00:00.000Z'),
    score,
  });
}

describe('applySubjectAwareRanking', () => {
  it('boosts memories that mention the requested subject', () => {
    const ranked = applySubjectAwareRanking('When Gina lost her job at Door Dash?', [
      buildResult('generic', 'Since I lost my job at Door Dash, things have been tough.', 0.9),
      buildResult('gina', 'As of January 20, 2023, Gina lost her job at Door Dash.', 0.2),
    ]);

    expect(ranked.subjects).toEqual(['Gina']);
    expect(ranked.keywords).toEqual(expect.arrayContaining([
      'lost', 'job', 'door', 'dash', 'door dash',
    ]));
    expect(ranked.protectedFingerprints).toHaveLength(1);
    expect(ranked.results[0].id).toBe('gina');
  });

  it('penalizes memories that mention a conflicting subject', () => {
    const ranked = applySubjectAwareRanking('When Gina lost her job at Door Dash?', [
      buildResult('jon', 'As of January 20, 2023, Jon lost his job as a banker.', 0.8),
      buildResult('gina', 'As of January 20, 2023, Gina lost her job at Door Dash.', 0.4),
    ]);

    expect(ranked.results[0].id).toBe('gina');
    expect(ranked.results[1].id).toBe('jon');
  });

  it('prefers event-matching memories over unrelated same-subject memories', () => {
    const ranked = applySubjectAwareRanking('When Gina lost her job at Door Dash?', [
      buildResult('studio', 'As of January 20, 2023, Gina is starting a dance studio.', 0.9),
      buildResult('loss', 'As of January 20, 2023, Gina lost her job at Door Dash.', 0.2),
    ]);

    expect(ranked.results[0].id).toBe('loss');
  });

  it('extracts subject and event anchors for exact keyword expansion', () => {
    expect(extractSubjectQueryAnchors('When Gina lost her job at Door Dash?'))
      .toEqual(['Gina', 'lost', 'job', 'door', 'dash', 'lost job', 'job door', 'door dash']);
  });

  it('drops temporal filler anchors but keeps high-signal bigrams', () => {
    const anchors = extractSubjectQueryAnchors(
      "How many months lapsed between Avery's first and second maintenance appointment?",
    );

    expect(anchors).toContain('Averys');
    expect(anchors).toContain('appointment');
    expect(anchors).toContain('maintenance appointment');
    expect(anchors).not.toContain('many');
    expect(anchors).not.toContain('months');
    expect(anchors).not.toContain('between');
    expect(anchors).not.toContain('first');
    expect(anchors).not.toContain('second');
  });

  it('adds normalized event variants for temporal subject anchors', () => {
    const anchors = extractSubjectQueryAnchors(
      'How many weeks passed between Maria adopting Coco and Shadow?',
    );

    expect(anchors).toContain('adopting');
    expect(anchors).toContain('adopt');
  });

  it('penalizes planning-like later memories for temporal event queries', () => {
    const ranked = applySubjectAwareRanking(
      "How many months lapsed between Avery's first and second maintenance appointment?",
      [
        buildResult('plan', 'Avery planned to schedule another maintenance appointment in January.', 1.1),
        buildResult('done', 'Avery completed a second maintenance appointment.', 0.6),
      ],
    );

    expect(ranked.results[0].id).toBe('done');
    expect(ranked.results[1].id).toBe('plan');
  });

  it('prefers memories that mention more of the requested endpoint anchors', () => {
    const ranked = applySubjectAwareRanking(
      'How many weeks passed between Maria adopting Coco and Shadow?',
      [
        buildResult('generic', 'Maria adopted a dog earlier this year.', 0.9),
        buildResult('specific', 'Maria adopted Coco and felt instantly attached.', 0.4),
      ],
    );

    expect(ranked.results[0].id).toBe('specific');
  });
});
