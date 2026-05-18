/**
 * @file Live Ink dashboard for bare `atomicmemory` and explicit
 * `--interactive` sessions. This component owns terminal input,
 * command execution state, scroll follow behavior, and delegates
 * presentation/formatting to the focused dashboard modules.
 */

import { performance } from 'node:perf_hooks';
import React, { useEffect, useMemo, useState } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { runWithCapturedConsole } from './console-capture.js';
import {
  CommandMenu,
  LogoHeader,
  PromptBar,
  SessionPanel,
  StatusStrip,
} from './components.js';
import { formatCommandError, formatDashboardCommandResult } from './format.js';
import {
  commandForSubmittedMenuInput,
  commandMenuItems,
  commandMenuReservedRows,
  interactiveHelpText,
  isCommandMenuInput,
} from './menu.js';
import {
  clampScrollOffset,
  compactHeaderForTerminal,
  compactLayoutForTerminal,
  DEFAULT_TERMINAL_COLUMNS,
  DEFAULT_TERMINAL_ROWS,
  linesForEvents,
  MIN_INNER_WIDTH,
  sessionBodyHeightForTerminal,
  sessionScrollOffset,
  TERMINAL_HORIZONTAL_MARGIN,
  viewportLines,
} from './session.js';
import type { CommandEvent, InteractiveDashboardOptions, TuiColor } from './types.js';

type InputKey = Parameters<Parameters<typeof useInput>[0]>[1];

const MAX_EVENT_HISTORY = 50;

export const InteractiveDashboard: React.FC<InteractiveDashboardOptions> = ({
  apiUrl,
  color,
  initialResult,
  profileName,
  provider,
  runCommand,
  scope,
  version,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns ?? DEFAULT_TERMINAL_COLUMNS;
  const terminalHeight = stdout.rows ?? DEFAULT_TERMINAL_ROWS;
  const innerWidth = Math.max(MIN_INNER_WIDTH, terminalWidth - TERMINAL_HORIZONTAL_MARGIN);
  const compactHeader = compactHeaderForTerminal(terminalHeight);
  const compactLayout = compactLayoutForTerminal(terminalHeight);
  const accent: TuiColor | undefined = color ? 'cyanBright' : undefined;
  const muted: TuiColor | undefined = color ? 'gray' : undefined;
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [followOutput, setFollowOutput] = useState(true);
  const [events, setEvents] = useState<CommandEvent[]>(() => initialEvents(initialResult));

  const menuVisible = isCommandMenuInput(input);
  const menuItems = useMemo(() => commandMenuItems(input), [input]);
  const menuReplacesSession = menuVisible && compactLayout;
  const menuReservedRows = menuVisible && !menuReplacesSession ? commandMenuReservedRows(menuItems.length, compactLayout) : 0;
  const sessionBodyHeight = menuReplacesSession
    ? 0
    : sessionBodyHeightForTerminal(terminalHeight, compactHeader, compactLayout, menuReservedRows);
  const sessionLines = useMemo(() => linesForEvents(events, accent, muted, innerWidth), [accent, events, innerWidth, muted]);
  const maxScrollOffset = clampScrollOffset(sessionLines.length, sessionBodyHeight, Number.MAX_SAFE_INTEGER);
  const clampedScrollOffset = sessionScrollOffset(sessionLines.length, sessionBodyHeight, scrollOffset, followOutput);
  const visibleSessionLines = viewportLines(sessionLines, sessionBodyHeight, clampedScrollOffset);

  useEffect(() => {
    setSelected((value) => (menuVisible ? Math.min(value, Math.max(menuItems.length - 1, 0)) : 0));
  }, [menuItems.length, menuVisible]);

  useEffect(() => {
    if (followOutput) return;
    setScrollOffset((value) => clampScrollOffset(sessionLines.length, sessionBodyHeight, value));
  }, [followOutput, sessionBodyHeight, sessionLines.length]);

  useInput((value, key) => {
    if (handleExitInput(value, key)) return;
    if (handleNavigationInput(value, key)) return;
    if (busy) return;
    handleEditableInput(value, key);
  });

  function handleExitInput(value: string, key: InputKey): boolean {
    if (!isCtrlKey(value, key, 'c')) return false;
    exit();
    return true;
  }

  function handleNavigationInput(value: string, key: InputKey): boolean {
    const lineDelta = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (lineDelta !== 0) {
      navigateVertical(lineDelta);
      return true;
    }
    const pageDelta = pageScrollDelta(value, key, sessionBodyHeight);
    if (pageDelta === 0) return false;
    scrollSessionBy(pageDelta);
    return true;
  }

  function handleEditableInput(value: string, key: InputKey): boolean {
    if (isCtrlKey(value, key, 'l')) return clearSession();
    if (key.escape) return clearInput();
    if (key.tab) return completeSelectedCommand();
    if (key.backspace || key.delete) return deleteInputCharacter();
    if (isReturnInput(value, key)) return submitPromptInput(value);
    if (!isPrintableInput(value, key)) return false;
    setInput((current) => `${current}${value}`);
    scrollSessionToBottom();
    return true;
  }

  function submitPromptInput(value: string): boolean {
    const nextInput = inputWithReturnPayload(input, value);
    const chosen = isCommandMenuInput(nextInput)
      ? commandForSubmittedMenuInput(nextInput, selected, menuItems)
      : nextInput;
    if (chosen?.endsWith(' ')) {
      setInput(chosen);
      scrollSessionToBottom();
      return true;
    }
    scrollSessionToBottom();
    void submitLine(chosen ?? '');
    return true;
  }

  async function submitLine(line: string) {
    const command = line.trim();
    if (!command || handleDashboardCommand(command)) return;
    await runUserCommand(command);
  }

  function handleDashboardCommand(command: string): boolean {
    if (command === '/quit' || command === '/exit' || command === 'quit' || command === 'exit') {
      exit();
      return true;
    }
    if (isHelpCommand(command)) {
      appendEvent({ id: Date.now(), kind: 'system', title: 'help', body: interactiveHelpText() });
      setInput('');
      scrollSessionToBottom();
      return true;
    }
    if (command === '/clear' || command === 'clear') {
      setEvents([]);
      setInput('');
      scrollSessionToBottom();
      return true;
    }
    return false;
  }

  async function runUserCommand(command: string) {
    // Set busy state and clear the input buffer; React paints
    // naturally between the awaits inside `runCommand` for any
    // provider-touching work. Fast provider-free commands (`help`,
    // `version`, `config show`, `skill list`) may finish before the
    // busy spinner paints — this is purely cosmetic and acceptable;
    // correctness does not depend on that frame. We deliberately
    // avoid `setTimeout(0)` here per the workspace "no timing-based
    // solutions" rule.
    setBusy(true);
    setInput('');
    scrollSessionToBottom();
    const started = performance.now();
    const outcome = await runWithCapturedConsole(() => runCommand(command));
    const durationMs = Math.round(performance.now() - started);
    if (outcome.error === undefined) recordSuccess(command, outcome.result, outcome.captured, durationMs);
    else recordFailure(command, outcome.error, outcome.captured, durationMs);
    setBusy(false);
  }

  function recordSuccess(command: string, result: Awaited<ReturnType<typeof runCommand>>, captured: string, durationMs: number) {
    appendEvent({
      id: Date.now(),
      kind: 'result',
      title: `$ ${command}`,
      body: formatDashboardCommandResult(result, captured),
      durationMs,
    });
    scrollSessionToBottom();
  }

  function recordFailure(command: string, error: unknown, captured: string, durationMs: number) {
    appendEvent({
      id: Date.now(),
      kind: 'error',
      title: `$ ${command}`,
      body: formatCommandError(error, captured),
      durationMs,
    });
    scrollSessionToBottom();
  }

  function appendEvent(event: CommandEvent) {
    setEvents((current) => [...current, event].slice(-MAX_EVENT_HISTORY));
  }

  function navigateVertical(delta: number) {
    if (!busy && menuVisible) {
      setSelected((current) => wrapIndex(current + delta, menuItems.length));
      return;
    }
    scrollSessionBy(delta);
  }

  function completeSelectedCommand(): boolean {
    const suggestion = menuVisible ? menuItems[selected]?.command : undefined;
    if (!suggestion) return true;
    setInput(suggestion);
    scrollSessionToBottom();
    return true;
  }

  function clearSession(): boolean {
    setEvents([]);
    setScrollOffset(0);
    scrollSessionToBottom();
    return true;
  }

  function clearInput(): boolean {
    setInput('');
    scrollSessionToBottom();
    return true;
  }

  function deleteInputCharacter(): boolean {
    setInput((current) => current.slice(0, -1));
    scrollSessionToBottom();
    return true;
  }

  function scrollSessionToBottom() {
    setFollowOutput(true);
    setScrollOffset(Number.MAX_SAFE_INTEGER);
  }

  function scrollSessionBy(delta: number) {
    const next = clampScrollOffset(sessionLines.length, sessionBodyHeight, clampedScrollOffset + delta);
    setScrollOffset(next);
    setFollowOutput(next >= maxScrollOffset);
  }

  return (
    <Box flexDirection="column" height={terminalHeight} paddingX={1} paddingTop={1}>
      <LogoHeader accent={accent} compact={compactHeader} muted={muted} terminalWidth={terminalWidth} version={version} />
      <StatusStrip
        apiUrl={apiUrl}
        borderColor={accent}
        innerWidth={innerWidth}
        mutedColor={muted}
        profileName={profileName}
        provider={provider}
        scope={scope}
      />
      {menuReplacesSession ? null : (
        <SessionPanel
          borderColor={accent}
          compact={compactLayout}
          flexGrow={1}
          lines={visibleSessionLines}
          maxScrollOffset={maxScrollOffset}
          mutedColor={muted}
          scrollOffset={clampedScrollOffset}
          totalLines={sessionLines.length}
          visibleHeight={sessionBodyHeight}
        />
      )}
      {menuVisible ? (
        <CommandMenu
          compact={compactLayout}
          innerWidth={innerWidth}
          items={menuItems}
          mutedColor={muted}
          selected={selected}
          selectedColor={accent}
        />
      ) : null}
      <PromptBar accent={accent} busy={busy} input={input} muted={muted} />
    </Box>
  );
};

function initialEvents(initialResult: InteractiveDashboardOptions['initialResult']): CommandEvent[] {
  const ready: CommandEvent = {
    id: 1,
    kind: 'system',
    title: 'ready',
    body: 'Type / for commands, /help for keys, Enter to run, /quit to exit.',
  };
  if (!initialResult) return [ready];
  return [
    ready,
    {
      id: 2,
      kind: 'result',
      title: `$ ${initialResult.command}`,
      body: formatDashboardCommandResult(initialResult),
    },
  ];
}

function wrapIndex(next: number, length: number): number {
  if (length <= 0) return 0;
  if (next < 0) return length - 1;
  if (next >= length) return 0;
  return next;
}

function isCtrlKey(value: string, key: InputKey, expected: string): boolean {
  return key.ctrl === true && value === expected;
}

function isReturnInput(value: string, key: InputKey): boolean {
  return key.return === true || value.includes('\r') || value.includes('\n');
}

function isPrintableInput(value: string, key: InputKey): boolean {
  return value.length > 0 && key.ctrl !== true && key.meta !== true;
}

function pageScrollDelta(value: string, key: InputKey, pageSize: number): number {
  if (key.pageUp || isCtrlKey(value, key, 'u')) return -pageSize;
  if (key.pageDown || isCtrlKey(value, key, 'd')) return pageSize;
  return 0;
}

function inputWithReturnPayload(input: string, value: string): string {
  return `${input}${value.replace(/[\r\n]/g, '')}`.trim();
}

function isHelpCommand(command: string): boolean {
  return command === '/help' || command === 'help' || command === '?';
}
