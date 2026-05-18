/**
 * Unit tests for repeated-event temporal endpoint evidence formatting.
 *
 * Covers the query-aware packaging helper that makes first/second event
 * endpoints explicit for temporal comparison questions.
 */

import { describe, expect, it } from 'vitest';
import { createSearchResult } from './test-fixtures.js';
import {
  buildRepeatedEventEndpointBlock,
  buildTemporalEvidenceBlock,
} from '../temporal-endpoint-evidence.js';

function makeMemory(id: string, content: string, date: string) {
  return createSearchResult({
    id,
    content,
    created_at: new Date(`${date}T00:00:00.000Z`),
  });
}

describe('buildRepeatedEventEndpointBlock', () => {
  it('emits first and second event endpoints for repeated-event queries', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('first', "Sam had a check-up with Sam's doctor a few days ago.", '2023-05-24'),
      makeMemory('second', "Sam had a doctor's appointment as a wake-up call.", '2023-08-15'),
    ], "How many months lapsed between Sam's first and second doctor's appointment?");

    expect(block).toContain('Repeated event endpoints:');
    expect(block).toContain('first matching event: 2023-05-24');
    expect(block).toContain('second matching event: 2023-08-15');
    expect(block).toContain('elapsed between endpoints: ~3 months (83 days)');
  });

  it('does not emit when only one matching event date is present', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('only', "Sam had a doctor's appointment as a wake-up call.", '2023-08-15'),
      makeMemory('context', 'Sam considered painting to help de-stress.', '2023-05-24'),
    ], "How many months lapsed between Sam's first and second doctor's appointment?");

    expect(block).toBe('');
  });

  it('keeps the repeated-event block narrow for non-repeated temporal queries', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('first', 'James met Samantha.', '2022-08-10'),
      makeMemory('second', 'James and Samantha decided to move in.', '2022-10-31'),
    ], 'How long did James and Samantha date before moving in?');

    expect(block).toBe('');
  });

  it('emits a compact general temporal block for non-repeated temporal queries', () => {
    const block = buildTemporalEvidenceBlock([
      makeMemory('first', 'Alex and Jordan started work on the migration.', '2022-08-10'),
      makeMemory('second', 'Alex and Jordan launched the migration together.', '2022-10-31'),
      makeMemory('noise', 'Alex updated unrelated documentation.', '2022-09-01'),
    ], 'How long did Alex and Jordan work before launch?');

    expect(block).toContain('Temporal evidence candidates:');
    expect(block).toContain('earliest matching event: 2022-08-10');
    expect(block).toContain('latest matching event: 2022-10-31');
    expect(block).toContain('elapsed between endpoints: ~3 months (82 days)');
  });

  it('normalizes common temporal verb forms when selecting general evidence', () => {
    const block = buildTemporalEvidenceBlock([
      makeMemory('winner', 'Jordan won the annual robotics award.', '2022-08-21'),
      makeMemory('adoption', 'Morgan adopted a new workflow later in the year.', '2022-10-29'),
    ], 'When did Jordan win the robotics award?');

    expect(block).toContain('matching event: 2022-08-21');
  });

  it('prefers completed repeated events over later planning-like events', () => {
    const block = buildTemporalEvidenceBlock([
      makeMemory('first', 'Avery completed the first maintenance appointment.', '2023-05-24'),
      makeMemory('second', 'Avery completed a second maintenance appointment after repairs.', '2023-08-15'),
      makeMemory('plan', 'Avery planned to schedule another maintenance appointment in January.', '2024-01-10'),
    ], "How many months lapsed between Avery's first and second maintenance appointment?");

    expect(block).toContain('first matching event: 2023-05-24');
    expect(block).toContain('second matching event: 2023-08-15');
    expect(block).not.toContain('2024-01-10');
  });

  it('penalizes planning-like later events for general duration questions', () => {
    const block = buildTemporalEvidenceBlock([
      makeMemory('first', 'Avery completed a maintenance appointment in May.', '2023-05-24'),
      makeMemory('second', 'Avery completed a second maintenance appointment after repairs.', '2023-08-15'),
      makeMemory('plan', 'Avery is going to schedule a new maintenance appointment in January.', '2024-01-10'),
    ], "How long was it between Avery's maintenance appointments?");

    expect(block).toContain('earliest matching event: 2023-05-24');
    expect(block).toContain('latest matching event: 2023-08-15');
    expect(block).not.toContain('2024-01-10');
  });

  it('rejects partial-match endpoints (one memory hits "doctor", another hits "appointment")', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('doc-only', 'Sam saw the doctor about a sore knee.', '2023-05-24'),
      makeMemory('appt-only', 'Sam booked a haircut appointment with the salon.', '2023-08-15'),
    ], "How many months between Sam's first and second doctor appointment?");

    expect(block).toBe('');
  });

  it('expands plural query terms back to canonical singular synonyms', () => {
    const block = buildRepeatedEventEndpointBlock([
      makeMemory('first', "Sam had a check-up with Sam's doctor a few days ago.", '2023-05-24'),
      makeMemory('second', "Sam had a doctor's appointment as a wake-up call.", '2023-08-15'),
    ], 'How many weeks elapsed between the first and second appointments?');

    expect(block).toContain('Repeated event endpoints:');
    expect(block).toContain('first matching event: 2023-05-24');
    expect(block).toContain('second matching event: 2023-08-15');
  });
});
