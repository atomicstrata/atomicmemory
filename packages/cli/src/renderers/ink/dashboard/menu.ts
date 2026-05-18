/**
 * @file Slash-command menu data and pure selection helpers for the
 * interactive dashboard. These functions are intentionally React-free
 * so command filtering and Enter/Tab selection can be covered with
 * focused unit tests.
 */

import type { CommandShortcut } from './types.js';

const SHORTCUTS: CommandShortcut[] = [
  { command: '/help', label: 'help', hint: 'show interactive commands and keyboard shortcuts' },
  { command: 'doctor', label: 'doctor', hint: 'verify config and provider health' },
  { command: 'status', label: 'status', hint: 'show active provider capabilities' },
  { command: 'validate', label: 'validate', hint: 'check CLI package, spec, schema, and skill health' },
  { command: 'skill get core', label: 'skill', hint: 'show bundled agent instructions' },
  { command: 'config show', label: 'config', hint: 'inspect current local configuration' },
  { command: 'search ', label: 'search', hint: 'search scoped memories' },
  { command: 'add ', label: 'add', hint: 'ingest a short memory' },
  { command: 'package ', label: 'package', hint: 'build prompt-ready context' },
  { command: 'list', label: 'list', hint: 'list scoped memories' },
];

export function isCommandMenuInput(value: string): boolean {
  return value.startsWith('/') && !['/quit', '/exit', '/clear', '/help'].includes(value.trim());
}

export function commandMenuItems(input: string): CommandShortcut[] {
  const query = input.startsWith('/') ? input.slice(1).trim().toLowerCase() : input.trim().toLowerCase();
  if (!query) return SHORTCUTS;
  const directMatches = SHORTCUTS.filter((item) =>
    item.command.toLowerCase().includes(query) || item.label.toLowerCase().includes(query),
  );
  if (directMatches.length > 0) return directMatches;
  return SHORTCUTS.filter((item) => item.hint.toLowerCase().includes(query));
}

export function commandMenuReservedRows(itemCount: number, compact: boolean): number {
  const contentRows = Math.max(1, itemCount) + (compact ? 0 : 1);
  return contentRows + 3;
}

export function commandForSubmittedMenuInput(
  input: string,
  selected: number,
  items = commandMenuItems(input),
): string | undefined {
  const index = Math.min(selected, Math.max(items.length - 1, 0));
  return commandFromMenuInput(input, items[index]);
}

export function interactiveHelpText(): string {
  return [
    'Commands',
    '  /                 open the command menu',
    '  /help, help, ?    show this help section',
    '  /clear, clear     clear the session output',
    '  /quit, /exit      exit interactive mode',
    '',
    'Keyboard',
    '  Enter             run the current command',
    '  Tab               complete the selected menu command',
    '  Escape            close the command menu or clear input',
    '  Up / Down         scroll session output',
    '  PageUp / PageDown scroll session output by a page',
    '  Ctrl+U / Ctrl+D   scroll session output by a page',
    '  Ctrl+L            clear the session output',
    '  Ctrl+C            exit interactive mode',
    '',
    'Examples',
    '  status',
    '  search "release policy"',
    '  add "Prefer short CLI output with provenance" --source cli',
    '  package "what should the agent know before editing docs?"',
  ].join('\n');
}

export function commandMenuCommandWidth(items: CommandShortcut[], innerWidth: number): number {
  const longest = Math.max(7, ...items.map((item) => commandDisplay(item).length));
  const maxWidth = Math.max(10, Math.floor(innerWidth * 0.4));
  return Math.min(longest, maxWidth);
}

export function commandDisplay(item: CommandShortcut): string {
  switch (item.command) {
    case 'search ':
      return 'search <query>';
    case 'add ':
      return 'add <text>';
    case 'package ':
      return 'package <query>';
    default:
      return item.command.trim() || item.label;
  }
}

export function padEnd(value: string, width: number): string {
  if (value.length >= width) return value;
  return `${value}${' '.repeat(width - value.length)}`;
}

export function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function commandFromMenuInput(input: string, selectedItem: CommandShortcut | undefined): string | undefined {
  if (selectedItem) return selectedItem.command;
  const query = input.slice(1).trim();
  return query || undefined;
}
