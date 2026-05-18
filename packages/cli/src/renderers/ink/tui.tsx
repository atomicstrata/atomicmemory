/**
 * @file Ink TUI for v5 success render. Uses Ink's `Static` component
 * so the render is deterministic: every emitted line flushes once and
 * Ink exits when the static list is exhausted. No setTimeout, no
 * keyboard handlers, no live state. The live prompt dashboard is
 * implemented separately in dashboard.tsx so one-shot command output
 * stays deterministic.
 */

import React from 'react';
import { Box, Static, Text } from 'ink';
import type { CommandResult, RenderContext } from '../../types.js';

interface CommandResultViewProps {
  ctx: RenderContext;
  result: CommandResult<unknown>;
}

interface StaticLine {
  key: string;
  kind: 'header' | 'event' | 'data';
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

export const CommandResultView: React.FC<CommandResultViewProps> = ({
  ctx,
  result,
}) => {
  const lines = composeLines(ctx, result);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={lines}>
        {(line) => {
          const props: { color?: string; bold?: boolean; dimColor?: boolean } = {};
          if (line.color !== undefined) props.color = line.color;
          if (line.bold === true) props.bold = true;
          if (line.dim === true) props.dimColor = true;
          return (
            <Text key={line.key} {...props}>
              {line.text}
            </Text>
          );
        }}
      </Static>
    </Box>
  );
};

function composeLines(
  ctx: RenderContext,
  result: CommandResult<unknown>,
): StaticLine[] {
  const lines: StaticLine[] = [];
  const headerParts: string[] = [
    `atomicmemory · ${result.command} · profile=${ctx.profileName}`,
  ];
  if (ctx.scope?.user) headerParts.push(`user=${ctx.scope.user}`);
  lines.push({
    key: 'header',
    kind: 'header',
    text: headerParts.join(' · '),
    color: 'cyan',
    bold: true,
  });

  for (const [i, e] of (result.events ?? []).entries()) {
    lines.push({
      key: `event-${i}`,
      kind: 'event',
      text: `[${e.type}] ${e.message}`,
      color: eventColor(e.type),
    });
  }

  const dataLines = formatData(result.data);
  for (const [i, line] of dataLines.entries()) {
    lines.push({
      key: `data-${i}`,
      kind: 'data',
      text: line,
    });
  }

  return lines;
}

function eventColor(type: 'info' | 'progress' | 'warn'): string {
  switch (type) {
    case 'warn':
      return 'yellow';
    case 'progress':
      return 'cyan';
    case 'info':
    default:
      return 'white';
  }
}

function formatData(data: unknown): string[] {
  if (typeof data === 'string') return data.split('\n');
  if (data == null) return [''];
  return JSON.stringify(data, null, 2).split('\n');
}
