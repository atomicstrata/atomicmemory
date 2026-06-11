/**
 * @file `atomicmemory import <file|->` — bulk JSON import. Each record
 * is one of {content|memory|text} plus optional metadata/provenance/scope.
 *
 * Aggregates all created/updated/unchanged IDs from the per-record
 * adapter.addMemory calls into one envelope. Failures abort import
 * (no partial-success silent skip).
 *
 * `--type llmwiki` branches into the typed bridge import path that
 * lives in `./import-llmwiki.ts`. The generic path remains the default
 * so existing scripts keep working unchanged.
 */

import { readFileSync } from 'node:fs';
import { CliError } from '../../types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';
import type { AdapterAddInput } from '../../adapters/types.js';
import { runImportLlmwiki, type ImportLlmwikiResult } from './import-llmwiki.js';

interface ImportRecord {
  text: string;
  metadata?: Record<string, unknown>;
  provenance?: AdapterAddInput['provenance'];
}

export const importCommand: CommandHandler<
  | { created: string[]; updated: string[]; unchanged: string[] }
  | ImportLlmwikiResult
> = async (ctx) => {
  // Today the only typed-import target is 'llmwiki'. We dispatch
  // explicitly rather than treating any `--type` value as routable so
  // (a) the single-target nature is obvious to readers, and (b) the
  // typed-import surface stays generic in shape (`type: 'llmwiki'`
  // discriminator on meta) for when a second target is added.
  if (ctx.flags.type === 'llmwiki') {
    const result = await runImportLlmwiki(ctx);
    return {
      command: 'import',
      data: result,
      count: result.created.length + result.updated.length,
      meta: {
        // Discriminator (Q2): the typed-import meta carries `type:
        // 'llmwiki'`; the generic-import meta carries `type:
        // 'generic'`. Consumers parsing the meta envelope can branch
        // on this without needing to peek at other fields.
        type: 'llmwiki',
        dryRun: result.dryRunPages !== undefined,
        pages: result.dryRunPages?.length ?? result.created.length + result.updated.length + result.unchanged.length,
        ...(result.warning !== undefined && { warning: result.warning }),
      },
    };
  }
  // Any --type value other than the supported ones is rejected here
  // so the generic-import path doesn't get a cryptic file-shape error
  // for what is actually a flag-value typo.
  if (ctx.flags.type !== undefined) {
    throw new CliError(
      'usage',
      `--type "${String(ctx.flags.type)}" is not supported. Currently: --type llmwiki.`,
    );
  }

  const scope = requireScope(ctx);
  const records = await loadRecords(ctx);
  if (records.length === 0) {
    throw new CliError('missing_input', 'import received an empty record list');
  }

  const { adapter, capabilities } = await ctx.getAdapter();
  // Bulk import is structurally an ingest loop; enforce the same
  // operation-level requiredScope before any record goes upstream so a
  // partial batch never lands when the provider would have rejected
  // the missing field on record N.
  requireDynamicScope(ctx, 'ingest', capabilities);
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const rec of records) {
    const result = await adapter.addMemory({
      text: rec.text,
      scope,
      ...(rec.metadata ? { metadata: rec.metadata } : {}),
      ...(rec.provenance ? { provenance: rec.provenance } : {}),
    });
    created.push(...result.created);
    updated.push(...result.updated);
    unchanged.push(...result.unchanged);
  }

  return {
    command: 'import',
    data: { created, updated, unchanged },
    count: created.length + updated.length,
    // Q2 discriminator: the generic-import meta carries `type:
    // 'generic'` so consumers can branch the meta shape without
    // peeking at other fields.
    meta: { type: 'generic', records: records.length },
  };
};

async function loadRecords(
  ctx: import('../types.js').CommandContext,
): Promise<ImportRecord[]> {
  const target = ctx.positional[0];
  let raw: string;
  if (target === '-' || ctx.flags.stdin === true) {
    raw = await ctx.readStdin();
  } else if (target && target.length > 0) {
    raw = readFileSync(target, 'utf8');
  } else {
    throw new CliError('missing_input', 'import requires a file path or "-" (stdin)');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError('usage', `import payload is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new CliError('usage', 'import payload must be a JSON array');
  }
  return parsed.map((rec, idx) => toRecord(rec, idx));
}

function toRecord(raw: unknown, idx: number): ImportRecord {
  if (!raw || typeof raw !== 'object') {
    throw new CliError('usage', `record ${idx} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const text =
    typeof obj.content === 'string'
      ? obj.content
      : typeof obj.memory === 'string'
        ? obj.memory
        : typeof obj.text === 'string'
          ? obj.text
          : null;
  if (!text || text.length === 0) {
    throw new CliError('usage', `record ${idx} must include content|memory|text`);
  }
  const out: ImportRecord = { text };
  if (obj.metadata && typeof obj.metadata === 'object') {
    out.metadata = obj.metadata as Record<string, unknown>;
  }
  if (obj.provenance && typeof obj.provenance === 'object') {
    out.provenance = obj.provenance as AdapterAddInput['provenance'];
  }
  return out;
}
