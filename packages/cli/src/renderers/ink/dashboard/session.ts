/**
 * @file Session scroll and wrapping helpers for the dashboard output
 * pane. These utilities convert command events into fixed-height,
 * wrapped viewport lines so the React component only manages state
 * and input events.
 */

import type { CliScopePartial } from '../../../types.js';
import type { CommandEvent, SessionLine, TuiColor } from './types.js';

export const DEFAULT_TERMINAL_COLUMNS = 100;
export const DEFAULT_TERMINAL_ROWS = 32;
export const MIN_INNER_WIDTH = 20;
export const TERMINAL_HORIZONTAL_MARGIN = 6;

const COMPACT_HEADER_THRESHOLD = 34;
const COMPACT_LAYOUT_THRESHOLD = 28;
const MIN_SESSION_BODY_HEIGHT = 3;
const FULL_LAYOUT_RESERVED_ROWS = 25;
const COMPACT_HEADER_RESERVED_ROWS = 17;
const COMPACT_LAYOUT_RESERVED_ROWS = 15;

// Keeps long command output useful while preventing the session list
// from taking unbounded memory inside an always-running TUI.
const MAX_EVENT_BODY_LINES = 80;

export function compactHeaderForTerminal(terminalHeight: number): boolean {
  return terminalHeight < COMPACT_HEADER_THRESHOLD;
}

export function compactLayoutForTerminal(terminalHeight: number): boolean {
  return terminalHeight < COMPACT_LAYOUT_THRESHOLD;
}

export function linesForEvents(
  events: CommandEvent[],
  accent: TuiColor | undefined,
  muted: TuiColor | undefined,
  width: number,
): SessionLine[] {
  if (events.length === 0) {
    return [{ color: muted, key: 'empty', text: 'No output yet.' }];
  }

  return events.flatMap((event) => {
    const title = `${event.title}${event.durationMs !== undefined ? `  ${event.durationMs}ms` : ''}`;
    const titleColor = event.kind === 'error' ? 'redBright' : event.kind === 'system' ? muted : accent;
    const bodyColor = event.kind === 'error' ? 'redBright' : undefined;
    const body = eventBodyLines(event.body).flatMap((line, index) => {
      const lineColor = sessionBodyLineColor(bodyColor, line, accent);
      return wrapSessionLine(line || ' ', width).map((wrapped, wrappedIndex) => ({
        color: lineColor,
        key: `${event.id}-body-${index}-${wrappedIndex}`,
        text: wrapped,
      }));
    });

    return [
      {
        color: titleColor,
        key: `${event.id}-title`,
        text: title,
      },
      ...body,
      {
        color: undefined,
        key: `${event.id}-spacer`,
        text: ' ',
      },
    ];
  });
}

export function sessionScrollOffset(
  totalLines: number,
  visibleLines: number,
  manualOffset: number,
  followLatest: boolean,
): number {
  return clampScrollOffset(
    totalLines,
    visibleLines,
    followLatest ? Number.MAX_SAFE_INTEGER : manualOffset,
  );
}

export function viewportLines<T>(lines: T[], visibleLines: number, offset: number): T[] {
  const start = clampScrollOffset(lines.length, visibleLines, offset);
  return lines.slice(start, start + Math.max(0, visibleLines));
}

export function sessionBodyHeightForTerminal(
  terminalHeight: number,
  compactHeader = compactHeaderForTerminal(terminalHeight),
  compactLayout = compactLayoutForTerminal(terminalHeight),
  menuReservedRows = 0,
): number {
  const reservedRows = compactLayout
    ? COMPACT_LAYOUT_RESERVED_ROWS
    : compactHeader
      ? COMPACT_HEADER_RESERVED_ROWS
      : FULL_LAYOUT_RESERVED_ROWS;
  return Math.max(MIN_SESSION_BODY_HEIGHT, terminalHeight - reservedRows - menuReservedRows);
}

export function clampScrollOffset(totalLines: number, visibleLines: number, offset: number): number {
  if (totalLines <= 0 || visibleLines <= 0) return 0;
  const max = Math.max(0, totalLines - visibleLines);
  return Math.min(max, Math.max(0, offset));
}

export function scopeSummary(scope: CliScopePartial | undefined): string {
  if (!scope || Object.keys(scope).length === 0) return 'not configured';
  const parts = [
    scope.user ? `user=${scope.user}` : undefined,
    scope.agent_id ? `agent=${scope.agent_id}` : undefined,
    scope.namespace ? `namespace=${scope.namespace}` : undefined,
    scope.thread ? `thread=${scope.thread}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' ') : 'not configured';
}

export function wrapSessionLine(value: string, width: number): string[] {
  if (width <= 0) return [''];
  if (value.length <= width) return [value];

  const lines: string[] = [];
  const indent = value.match(/^\s*/)?.[0] ?? '';
  const continuationIndent = (indent.length > 0 ? indent : '  ').slice(0, Math.max(0, width - 1));
  let remaining = value;

  while (remaining.length > width) {
    const breakAt = findWrapIndex(remaining, width);
    lines.push(remaining.slice(0, breakAt).replace(/\s+$/, '') || ' ');
    remaining = `${continuationIndent}${remaining.slice(breakAt).replace(/^\s+/, '')}`;
  }
  lines.push(remaining || ' ');
  return lines;
}

function eventBodyLines(body: string): string[] {
  const lines = body.split('\n');
  if (lines.length <= MAX_EVENT_BODY_LINES) return lines;

  const remaining = lines.length - MAX_EVENT_BODY_LINES;
  return [
    ...lines.slice(0, MAX_EVENT_BODY_LINES),
    `...${remaining} more lines; run the command outside interactive mode for the complete output.`,
  ];
}

function sessionBodyLineColor(
  fallback: TuiColor | undefined,
  line: string,
  accent: TuiColor | undefined,
): TuiColor | undefined {
  if (fallback) return fallback;
  const trimmed = line.trimStart();
  if (trimmed.startsWith('✓')) return accent ? 'greenBright' : undefined;
  if (trimmed.startsWith('✗')) return accent ? 'redBright' : undefined;
  return undefined;
}

function findWrapIndex(value: string, width: number): number {
  if (value.length <= width) return value.length;
  const leadingWhitespace = value.match(/^\s*/)?.[0].length ?? 0;
  const minBreak = Math.min(width, leadingWhitespace + 1);
  for (let index = width; index > 0; index -= 1) {
    if (index <= minBreak) break;
    if (/\s/.test(value[index] ?? '')) return index;
  }
  return width;
}
