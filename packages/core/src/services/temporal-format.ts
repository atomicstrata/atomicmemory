/**
 * Shared temporal formatting helpers.
 *
 * Used by retrieval-format and temporal-endpoint-evidence to render the
 * same date keys and duration strings without each file maintaining its
 * own copy.
 */

const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

export function formatDateLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatDuration(days: number): string {
  if (days < DAYS_PER_WEEK) return `${days} day${days !== 1 ? 's' : ''}`;
  const weeks = Math.round(days / DAYS_PER_WEEK);
  if (days < DAYS_PER_MONTH) return `~${weeks} week${weeks !== 1 ? 's' : ''} (${days} days)`;
  const months = Math.round(days / DAYS_PER_MONTH);
  return `~${months} month${months !== 1 ? 's' : ''} (${days} days)`;
}
