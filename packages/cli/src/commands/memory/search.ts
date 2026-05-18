/**
 * @file `atomicmemory search <query>` — semantic search.
 *
 * v5 contract:
 *   - --threshold is rejected (drift between provider scores).
 *     The commander spec does not declare it; if the user passes it,
 *     commander auto-errors.
 *   - --filter-json accepts an SDK FilterExpr JSON; we validate it is
 *     parseable JSON before adapter init (zod-validation of the SDK
 *     shape is the SDK's job; we only enforce JSON structure here).
 *   - --reranker is capability-gated.
 */

import { CliError } from '../../types.js';
import { assertReranker } from '../../capability-gate.js';
import { assertLimit } from '../../cli/limits.js';
import type {
  AdapterSearchHit,
  AdapterSearchInput,
} from '../../adapters/types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';

export const search: CommandHandler<AdapterSearchHit[]> = async (ctx) => {
  const query = ctx.positional.join(' ').trim();
  if (!query) {
    throw new CliError('missing_input', 'search requires a query');
  }
  const scope = requireScope(ctx);

  // Validate --filter-json BEFORE provider init so a malformed filter
  // surfaces as a usage error without spinning up the adapter (and
  // without surfacing a missing-profile error from getAdapter when
  // the real problem is the filter syntax). Per v5: machine-mode
  // callers expect input-level errors to fire ahead of network /
  // capability checks.
  const filterJson =
    typeof ctx.flags['filter-json'] === 'string'
      ? parseFilterJson(ctx.flags['filter-json'] as string)
      : undefined;

  const { adapter, capabilities } = await ctx.getAdapter();
  // Dynamic scope: provider's requiredScope (operation-specific or
  // default) must be satisfied before any adapter call. The static
  // stage in lifecycle.ts already enforced `user` for memory-touching
  // commands; this catches provider-imposed requirements like
  // namespace or agent_id that we can only know after capabilities
  // load.
  requireDynamicScope(ctx, 'search', capabilities);

  const input: AdapterSearchInput = { query, scope };
  if (typeof ctx.flags.limit === 'number') {
    assertLimit(ctx.flags.limit);
    input.limit = ctx.flags.limit;
  }
  if (filterJson !== undefined) input.filterJson = filterJson;
  if (typeof ctx.flags.reranker === 'string') {
    assertReranker(capabilities, ctx.flags.reranker);
    input.reranker = ctx.flags.reranker;
  }

  const hits = await adapter.searchMemories(input);
  return {
    command: 'search',
    data: hits,
    count: hits.length,
    meta: {
      truncated: false,
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    },
  };
};

function parseFilterJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      'usage',
      `--filter-json is not valid JSON: ${(err as Error).message}`,
    );
  }
}
