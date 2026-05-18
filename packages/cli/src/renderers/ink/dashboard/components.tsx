/**
 * @file Presentational Ink components for the live dashboard. The
 * components here have no command execution logic; they render the
 * logo, status strip, scrollable session panel, menu, and prompt.
 */

import React, { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { renderGeminiWordmark, wordmarkSpacingForWidth } from '../../../style.js';
import {
  commandDisplay,
  commandMenuCommandWidth,
  padEnd,
  truncateText,
} from './menu.js';
import { scopeSummary } from './session.js';
import type {
  CommandShortcut,
  InteractiveDashboardOptions,
  SessionLine,
  TuiColor,
} from './types.js';

export function LogoHeader({
  accent,
  compact,
  muted,
  terminalWidth,
  version,
}: {
  accent: TuiColor | undefined;
  compact: boolean;
  muted: TuiColor | undefined;
  terminalWidth: number;
  version: string;
}) {
  const logoLines = renderGeminiWordmark('ATOMICMEMORY', wordmarkSpacingForWidth(terminalWidth), accent !== undefined).split('\n');

  if (compact) {
    return (
      <Box marginBottom={1}>
        <Text>
          <Text bold>atomicmemory</Text>
          <ColorText color={muted}> CLI v{version}</ColorText>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {logoLines.map((line, rowIndex) => (
        <Text key={rowIndex}>{line}</Text>
      ))}
      <Text>
        <Text bold>atomicmemory</Text>
        <ColorText color={muted}> CLI v{version}</ColorText>
      </Text>
    </Box>
  );
}

export function StatusStrip({
  apiUrl,
  borderColor,
  innerWidth,
  mutedColor,
  profileName,
  provider,
  scope,
}: {
  apiUrl: string | undefined;
  borderColor: TuiColor | undefined;
  innerWidth: number;
  mutedColor: TuiColor | undefined;
  profileName: string;
  provider: string | undefined;
  scope: InteractiveDashboardOptions['scope'];
}) {
  const scopeLabel = scopeSummary(scope);

  return (
    <Box borderStyle="single" borderColor={borderColor} flexDirection="column" marginBottom={1} paddingX={1}>
      <Text>
        <ColorText color={mutedColor}>provider </ColorText>
        <Text bold>{provider ?? 'unconfigured'}</Text>
        <ColorText color={mutedColor}>  profile </ColorText>
        <Text>{profileName}</Text>
      </Text>
      <ColorText color={mutedColor}>{truncateText(`scope ${scopeLabel}  ${apiUrl ?? 'run init or pass --api-url'}`, innerWidth)}</ColorText>
    </Box>
  );
}

export function SessionPanel({
  borderColor,
  compact,
  flexGrow,
  lines,
  maxScrollOffset,
  mutedColor,
  scrollOffset,
  totalLines,
  visibleHeight,
}: {
  borderColor: TuiColor | undefined;
  compact: boolean;
  flexGrow?: number;
  lines: SessionLine[];
  maxScrollOffset: number;
  mutedColor: TuiColor | undefined;
  scrollOffset: number;
  totalLines: number;
  visibleHeight: number;
}) {
  const firstLine = totalLines === 0 ? 0 : scrollOffset + 1;
  const lastLine = Math.min(totalLines, scrollOffset + visibleHeight);

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      flexDirection="column"
      flexGrow={flexGrow}
      flexShrink={1}
      height={visibleHeight + (compact ? 2 : 3)}
      marginBottom={1}
      paddingX={1}
    >
      {compact ? null : (
        <Text>
          <ColorText color={mutedColor}>session</ColorText>
          {maxScrollOffset > 0 ? (
            <ColorText color={mutedColor}>  lines {firstLine}-{lastLine}/{totalLines}</ColorText>
          ) : null}
        </Text>
      )}
      {lines.map((line) => (
        <ColorText color={line.color} key={line.key}>
          {line.text || ' '}
        </ColorText>
      ))}
    </Box>
  );
}

export function CommandMenu({
  compact,
  innerWidth,
  items,
  mutedColor,
  selected,
  selectedColor,
}: {
  compact: boolean;
  innerWidth: number;
  items: CommandShortcut[];
  mutedColor: TuiColor | undefined;
  selected: number;
  selectedColor: TuiColor | undefined;
}) {
  const commandWidth = commandMenuCommandWidth(items, innerWidth);
  const descriptionWidth = Math.max(8, innerWidth - commandWidth - 5);

  return (
    <Box borderStyle="single" borderColor={selectedColor} flexDirection="column" marginBottom={1} paddingX={1}>
      {compact ? null : <ColorText color={mutedColor}>command menu</ColorText>}
      {items.length === 0 ? (
        <ColorText color={mutedColor}>No command matches the current input.</ColorText>
      ) : (
        items.map((item, index) => {
          const active = index === selected;
          const command = truncateText(commandDisplay(item), commandWidth);
          return (
            <Text key={item.command}>
              <ColorText color={active ? selectedColor : mutedColor}>{active ? '>' : ' '}</ColorText>
              <Text> </Text>
              <ColorText color={active ? selectedColor : undefined}>
                <Text bold>{padEnd(command, commandWidth)}</Text>
              </ColorText>
              <ColorText color={mutedColor}> {truncateText(item.hint, descriptionWidth)}</ColorText>
            </Text>
          );
        })
      )}
    </Box>
  );
}

export function PromptBar({
  accent,
  busy,
  input,
  muted,
}: {
  accent: TuiColor | undefined;
  busy: boolean;
  input: string;
  muted: TuiColor | undefined;
}) {
  return (
    <Box borderStyle="single" borderColor={busy ? 'yellow' : accent} paddingX={1}>
      <Text>
        <ColorText color={muted}>atomicmemory </ColorText>
        <ColorText color={busy ? 'yellow' : accent}>{busy ? 'working' : '>'}</ColorText>
        <Text> {busy ? 'running command...' : input}</Text>
        {!busy ? <ColorText color={accent}>_</ColorText> : null}
      </Text>
    </Box>
  );
}

function ColorText({ children, color }: { children: ReactNode; color: TuiColor | undefined }) {
  if (color) return <Text color={color}>{children}</Text>;
  return <Text>{children}</Text>;
}
