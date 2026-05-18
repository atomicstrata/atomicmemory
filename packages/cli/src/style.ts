const BLUE = '\u001b[38;5;153m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

function colorEnabled(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined && !process.argv.includes('--no-color');
}

function blue(text: string): string {
  return colorEnabled() ? `${BLUE}${text}${RESET}` : text;
}

export function bold(text: string): string {
  return colorEnabled() ? `${BOLD}${text}${RESET}` : text;
}

export function dim(text: string): string {
  return colorEnabled() ? `${DIM}${text}${RESET}` : text;
}

export function banner(version: string): string {
  return [
    renderGeminiWordmark('ATOMICMEMORY', wordmarkSpacingForWidth(process.stdout.columns ?? 80)),
    '',
    `${bold('atomicmemory')} ${dim(`CLI v${version}`)}`,
  ].join('\n');
}

type WordmarkTone = 'blank' | 'fill' | 'shadow';

interface WordmarkCell {
  char: string;
  color: string | undefined;
  tone: WordmarkTone;
}

export function renderGeminiWordmark(text = 'ATOMICMEMORY', spacing = 0, color = colorEnabled()): string {
  const rows = geminiWordmarkRows(text, spacing, color);
  return rows
    .map((row) =>
      row
        .map((cell) => (cell.color && cell.char !== ' ' ? ansiColor(cell.char, cell.color) : cell.char))
        .join('')
        .replace(/\s+$/, ''),
    )
    .join('\n');
}

export function geminiWordmarkRows(text = 'ATOMICMEMORY', spacing = 0, color = true): WordmarkCell[][] {
  const base = wordmarkLines(text, spacing);
  const width = Math.max(...base.map((line) => line.length));
  const outputHeight = color ? base.length + 1 : base.length;
  const outputWidth = color ? width + SHADOW_COLUMN_OFFSET : width;

  return Array.from({ length: outputHeight }, (_unused, row) =>
    Array.from({ length: outputWidth }, (_empty, column) => {
      const hasFill = isFilled(base, row, column);
      if (hasFill) {
        return {
          char: '█',
          color: color ? WORDMARK_FILL_HEX : undefined,
          tone: 'fill',
        };
      }

      const shadow = color ? shadowChar(base, row, column) : undefined;
      if (shadow) return shadow;

      return {
        char: ' ',
        color: undefined,
        tone: 'blank',
      };
    }),
  );
}

export function wordmarkLines(text = 'ATOMICMEMORY', spacing = 0): string[] {
  const letters = text.toUpperCase().split('').map((letter) => FONT[letter] ?? SPACE);
  return Array.from({ length: FONT_HEIGHT }, (_unused, row) =>
    letters.map((letter) => (letter[row] ?? '').replaceAll('#', '█')).join(' '.repeat(spacing)).replace(/\s+$/, ''),
  );
}

const FONT_HEIGHT = 7;
const FONT_WIDTH = 6;
const SHADOW_COLUMN_OFFSET = 1;
const SHADOW_ROW_OFFSET = 1;
const WORDMARK_FILL_HEX = '#ffffff';
const SHADOW_HEX = '#3a60e4';

export function wordmarkSpacingForWidth(width: number, text = 'ATOMICMEMORY'): number {
  const letterCount = text.length;
  if (letterCount <= 1) return 0;
  const spacedWidth = letterCount * FONT_WIDTH + (letterCount - 1) + SHADOW_COLUMN_OFFSET;
  return spacedWidth <= width ? 1 : 0;
}

function isFilled(lines: string[], row: number, column: number): boolean {
  if (row < 0 || column < 0) return false;
  return lines[row]?.[column] !== undefined && lines[row]?.[column] !== ' ';
}

function shadowChar(lines: string[], row: number, column: number): WordmarkCell | undefined {
  const side = isFilled(lines, row, column - SHADOW_COLUMN_OFFSET);
  const bottom = isFilled(lines, row - SHADOW_ROW_OFFSET, column);
  const corner = isFilled(lines, row - SHADOW_ROW_OFFSET, column - SHADOW_COLUMN_OFFSET);
  if (!side && !bottom && !corner) return undefined;

  return {
    char: side ? '▌' : bottom ? '▀' : '▘',
    color: SHADOW_HEX,
    tone: 'shadow',
  };
}

function ansiColor(text: string, hex: string): string {
  const rgb = parseHex(hex);
  return `\u001b[38;2;${rgb.red};${rgb.green};${rgb.blue}m${text}${RESET}`;
}

function parseHex(hex: string): { blue: number; green: number; red: number } {
  const normalized = hex.replace('#', '');
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

const SPACE = [
  '      ',
  '      ',
  '      ',
  '      ',
  '      ',
  '      ',
  '      ',
];

const FONT: Record<string, string[]> = {
  A: [
    ' #### ',
    '##  ##',
    '##  ##',
    '######',
    '##  ##',
    '##  ##',
    '##  ##',
  ],
  C: [
    ' #####',
    '##    ',
    '##    ',
    '##    ',
    '##    ',
    '##    ',
    ' #####',
  ],
  E: [
    '######',
    '##    ',
    '##    ',
    '##### ',
    '##    ',
    '##    ',
    '######',
  ],
  I: [
    '######',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '######',
  ],
  M: [
    '##  ##',
    '######',
    '######',
    '##  ##',
    '##  ##',
    '##  ##',
    '##  ##',
  ],
  O: [
    ' #### ',
    '##  ##',
    '##  ##',
    '##  ##',
    '##  ##',
    '##  ##',
    ' #### ',
  ],
  R: [
    '##### ',
    '##  ##',
    '##  ##',
    '##### ',
    '## ## ',
    '##  ##',
    '##  ##',
  ],
  T: [
    '######',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
  ],
  Y: [
    '##  ##',
    '##  ##',
    ' #### ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
  ],
  ' ': SPACE,
};

export function box(title: string, lines: string[]): string {
  const width = Math.max(title.length + 4, ...lines.map(stripAnsi).map((line) => line.length), 72);
  const titleSegment = ` ${title} `;
  const top = `${blue('+')}${dim(titleSegment)}${blue('-'.repeat(Math.max(1, width - titleSegment.length)))}${blue('+')}`;
  const bottom = `${blue('+')}${blue('-'.repeat(width))}${blue('+')}`;
  const body = lines.map((line) => `${blue('|')} ${line}${' '.repeat(width - stripAnsi(line).length)} ${blue('|')}`);
  return [top, ...body, bottom].join('\n');
}

export function columns(rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([left]) => stripAnsi(left).length));
  return rows.map(([left, right]) => `${left}${' '.repeat(width - stripAnsi(left).length)}  ${dim(right)}`);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
