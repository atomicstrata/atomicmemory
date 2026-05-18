/**
 * @file `atomicmemory add <text>` — single-text ingest. Sugar over
 * adapter.addMemory. Stdin support requires explicit `--stdin` per v5
 * §"Memory Operations" (otherwise an agent invocation might silently
 * read piped data).
 */

import { CliError } from '../../types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';

export const add: CommandHandler<{
  created: string[];
  updated: string[];
  unchanged: string[];
}> = async (ctx) => {
  const text = await resolveText(ctx);
  if (!text || text.length === 0) {
    throw new CliError('missing_input', 'add requires text content (positional, --file, or --stdin)');
  }
  const scope = requireScope(ctx);
  const { adapter, capabilities } = await ctx.getAdapter();
  // `add` is sugar over the ingest path; share the operation key so
  // provider-imposed scope rules apply uniformly to both surfaces.
  requireDynamicScope(ctx, 'ingest', capabilities);

  const metadata = parseMaybeJson(ctx.flags.metadata, 'metadata');
  const provenance: Record<string, string> = {};
  if (typeof ctx.flags.source === 'string') provenance.source = ctx.flags.source;
  if (typeof ctx.flags['source-url'] === 'string')
    provenance.sourceUrl = ctx.flags['source-url'] as string;
  if (typeof ctx.flags['source-id'] === 'string')
    provenance.sourceId = ctx.flags['source-id'] as string;

  const result = await adapter.addMemory({
    text,
    scope,
    ...(metadata ? { metadata } : {}),
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  });

  return {
    command: 'add',
    data: {
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
    },
    count: result.created.length + result.updated.length,
    meta: { mode: 'text' },
  };
};

async function resolveText(ctx: import('../types.js').CommandContext): Promise<string> {
  // v5 input precedence: file > positional text > stdin. `--file` wins
  // over the positional arg even when both are present, so a deliberate
  // file path can never be silently shadowed by a stale positional.
  if (typeof ctx.flags.file === 'string' && ctx.flags.file.length > 0) {
    // `--file -` is the canonical "read content from stdin" form.
    if (ctx.flags.file === '-') {
      return (await ctx.readStdin()).trim();
    }
    const { readFileSync } = await import('node:fs');
    return readFileSync(ctx.flags.file, 'utf8').trim();
  }
  const fromArgs = ctx.positional.join(' ').trim();
  if (fromArgs.length > 0) return fromArgs;
  if (ctx.flags.stdin === true) {
    return (await ctx.readStdin()).trim();
  }
  return '';
}

function parseMaybeJson(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('usage', `--${name} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('usage', `--${name} is not valid JSON: ${(err as Error).message}`);
  }
}
