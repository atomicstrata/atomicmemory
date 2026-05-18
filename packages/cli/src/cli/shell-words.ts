/**
 * @file Tiny shell-word splitter for the interactive dashboard prompt.
 * It supports quotes and backslash escaping without invoking a shell.
 */

export function splitShellWords(input: string): string[] {
  const state: ShellWordState = {
    current: '',
    escaped: false,
    quote: undefined,
    tokens: [],
  };
  for (const char of input.trim()) {
    consumeShellWordChar(state, char);
  }

  return finishShellWords(state);
}

type ShellQuote = '"' | "'";

interface ShellWordState {
  current: string;
  escaped: boolean;
  quote: ShellQuote | undefined;
  tokens: string[];
}

function consumeShellWordChar(state: ShellWordState, char: string): void {
  if (state.escaped) {
    appendCurrent(state, char);
    state.escaped = false;
    return;
  }
  if (char === '\\') {
    state.escaped = true;
    return;
  }
  if (state.quote) {
    consumeQuotedChar(state, char);
    return;
  }
  consumeUnquotedChar(state, char);
}

function consumeQuotedChar(state: ShellWordState, char: string): void {
  if (char === state.quote) {
    state.quote = undefined;
    return;
  }
  appendCurrent(state, char);
}

function consumeUnquotedChar(state: ShellWordState, char: string): void {
  if (isShellQuote(char)) {
    state.quote = char;
    return;
  }
  if (/\s/.test(char)) {
    flushCurrentToken(state);
    return;
  }
  appendCurrent(state, char);
}

function finishShellWords(state: ShellWordState): string[] {
  if (state.escaped) appendCurrent(state, '\\');
  if (state.quote) throw new Error(`Unclosed ${state.quote} quote`);
  flushCurrentToken(state);
  return state.tokens;
}

function appendCurrent(state: ShellWordState, value: string): void {
  state.current += value;
}

function flushCurrentToken(state: ShellWordState): void {
  if (!state.current) return;
  state.tokens.push(state.current);
  state.current = '';
}

function isShellQuote(value: string): value is ShellQuote {
  return value === '"' || value === "'";
}
