/**
 * @file Table renderer — used by list-shaped commands when the user picks
 * `--output table`. Phase 1 ships a simple two-mode renderer:
 *   - if `data` is an array of plain objects, print a fixed-width table;
 *   - otherwise fall back to JSON for inspection.
 *
 * Phase 5 list commands can supply a typed columns descriptor in
 * `result.meta.tableColumns` to customize column order and headers.
 */

import type { CommandResult, RenderContext } from '../types.js';

interface TableColumnsMeta {
  tableColumns?: Array<{ key: string; header?: string }>;
}

export function renderTableSuccess<T>(
  ctx: RenderContext,
  result: CommandResult<T>,
): void {
  const data = result.data;
  if (!Array.isArray(data) || data.length === 0) {
    process.stdout.write(JSON.stringify(data ?? null, null, 2) + '\n');
    return;
  }

  const columns = resolveColumns(data as Record<string, unknown>[], result.meta);
  const headers = columns.map((c) => c.header ?? c.key);
  const rows = data.map((row) =>
    columns.map((c) => stringifyCell((row as Record<string, unknown>)[c.key])),
  );

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );

  const lines: string[] = [];
  lines.push(headers.map((h, i) => padRight(h, widths[i] ?? h.length)).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    lines.push(
      r.map((cell, i) => padRight(cell, widths[i] ?? cell.length)).join('  '),
    );
  }

  process.stdout.write(lines.join('\n') + '\n');

  void ctx; // intentionally unused; available for future styling
}

export function renderTableError(_ctx: RenderContext, err: Error): void {
  process.stderr.write(`error: ${err.message}\n`);
}

function resolveColumns(
  rows: Record<string, unknown>[],
  meta?: Record<string, unknown>,
): Array<{ key: string; header?: string }> {
  const declared = (meta as TableColumnsMeta | undefined)?.tableColumns;
  if (declared && declared.length > 0) return declared;
  const keys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) keys.add(k);
  }
  return Array.from(keys).map((key) => ({ key }));
}

function stringifyCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
