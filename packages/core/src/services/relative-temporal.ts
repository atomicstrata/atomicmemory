/**
 * Shared relative-temporal helpers for deterministic extraction and retrieval.
 * Converts phrases like "yesterday" or "next month" into explicit anchors
 * without depending on an LLM.
 */

export type RelativeTemporalPrecision = 'day' | 'week' | 'month';

export interface RelativeTemporalAnchor {
  eventDate: string;
  precision: RelativeTemporalPrecision;
  phrase: string;
}

interface RelativePattern {
  regex: RegExp;
  resolve: (recordedDate: Date) => RelativeTemporalAnchor;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const RELATIVE_PATTERNS: RelativePattern[] = [
  {
    regex: /\bthe day before\b/gi,
    resolve: (recordedDate) => buildDayAnchor('the day before', shiftDays(recordedDate, -1)),
  },
  {
    regex: /\bday before\b/gi,
    resolve: (recordedDate) => buildDayAnchor('day before', shiftDays(recordedDate, -1)),
  },
  {
    regex: /\byesterday\b/gi,
    resolve: (recordedDate) => buildDayAnchor('yesterday', shiftDays(recordedDate, -1)),
  },
  {
    regex: /\btoday\b/gi,
    resolve: (recordedDate) => buildDayAnchor('today', recordedDate),
  },
  {
    regex: /\btomorrow\b/gi,
    resolve: (recordedDate) => buildDayAnchor('tomorrow', shiftDays(recordedDate, 1)),
  },
  {
    regex: /\blast week\b/gi,
    resolve: (recordedDate) => ({
      eventDate: formatIsoDay(shiftDays(recordedDate, -7)),
      precision: 'week',
      phrase: 'last week',
    }),
  },
  ...Object.keys(WEEKDAY_INDEX).map((weekday) => ({
    regex: new RegExp(`\\blast\\s+${weekday}\\b`, 'gi'),
    resolve: (recordedDate: Date) => buildDayAnchor(`last ${weekday}`, previousWeekday(recordedDate, WEEKDAY_INDEX[weekday])),
  })),
  {
    regex: /\bthis month\b/gi,
    resolve: (recordedDate) => ({
      eventDate: formatIsoMonth(recordedDate),
      precision: 'month',
      phrase: 'this month',
    }),
  },
  {
    regex: /\blast month\b/gi,
    resolve: (recordedDate) => ({
      eventDate: formatIsoMonth(shiftMonths(recordedDate, -1)),
      precision: 'month',
      phrase: 'last month',
    }),
  },
  {
    regex: /\bnext month\b/gi,
    resolve: (recordedDate) => ({
      eventDate: formatIsoMonth(shiftMonths(recordedDate, 1)),
      precision: 'month',
      phrase: 'next month',
    }),
  },
];

export function annotateRelativeTemporalText(text: string, recordedDate: Date): string {
  let annotated = text;
  for (const pattern of RELATIVE_PATTERNS) {
    annotated = annotated.replace(pattern.regex, (match) => {
      const anchor = pattern.resolve(recordedDate);
      return `${match} (${formatAnchorDescriptor(anchor)})`;
    });
  }
  return annotated;
}

export function extractRelativeTemporalAnchors(text: string, recordedDate: Date): RelativeTemporalAnchor[] {
  const anchors: RelativeTemporalAnchor[] = [];
  for (const pattern of RELATIVE_PATTERNS) {
    const matches = text.match(pattern.regex);
    if (!matches) continue;
    for (const _match of matches) {
      anchors.push(pattern.resolve(recordedDate));
    }
  }
  return dedupeAnchors(anchors);
}

export function containsRelativeTemporalPhrase(text: string): boolean {
  return RELATIVE_PATTERNS.some((pattern) => {
    pattern.regex.lastIndex = 0;
    return pattern.regex.test(text);
  });
}

function buildDayAnchor(phrase: string, date: Date): RelativeTemporalAnchor {
  return {
    eventDate: formatIsoDay(date),
    precision: 'day',
    phrase,
  };
}

function formatAnchorDescriptor(anchor: RelativeTemporalAnchor): string {
  if (anchor.precision === 'month') {
    return `in ${formatHumanMonth(anchor.eventDate)}`;
  }
  if (anchor.precision === 'week') {
    return `around ${formatHumanDay(anchor.eventDate)}`;
  }
  return `on ${formatHumanDay(anchor.eventDate)}`;
}

function dedupeAnchors(anchors: RelativeTemporalAnchor[]): RelativeTemporalAnchor[] {
  const unique = new Map<string, RelativeTemporalAnchor>();
  for (const anchor of anchors) {
    unique.set(`${anchor.phrase}:${anchor.precision}:${anchor.eventDate}`, anchor);
  }
  return [...unique.values()];
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function shiftMonths(date: Date, months: number): Date {
  const shifted = new Date(date.getTime());
  shifted.setUTCMonth(shifted.getUTCMonth() + months, 1);
  return shifted;
}

function previousWeekday(date: Date, targetWeekday: number): Date {
  const shifted = new Date(date.getTime());
  const currentWeekday = shifted.getUTCDay();
  const delta = (currentWeekday - targetWeekday + 7) % 7 || 7;
  shifted.setUTCDate(shifted.getUTCDate() - delta);
  return shifted;
}

function formatIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatIsoMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function formatHumanDay(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatHumanMonth(isoMonth: string): string {
  const date = new Date(`${isoMonth}-01T00:00:00.000Z`);
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}
