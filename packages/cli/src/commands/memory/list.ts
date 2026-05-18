/**
 * @file `atomicmemory list` — paginated list of scoped memories.
 */

import type {
  AdapterListResult,
} from '../../adapters/types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';
import { assertLimit } from '../../cli/limits.js';

export const list: CommandHandler<AdapterListResult> = async (ctx) => {
  const scope = requireScope(ctx);
  if (typeof ctx.flags.limit === 'number') assertLimit(ctx.flags.limit);
  const { adapter, capabilities } = await ctx.getAdapter();
  requireDynamicScope(ctx, 'list', capabilities);
  const input: Parameters<typeof adapter.listMemories>[0] = { scope };
  if (typeof ctx.flags.limit === 'number') input.limit = ctx.flags.limit;
  if (typeof ctx.flags.cursor === 'string') input.cursor = ctx.flags.cursor;
  const page = await adapter.listMemories(input);
  return {
    command: 'list',
    data: page,
    count: page.memories.length,
    meta: {
      truncated: page.cursor !== undefined,
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    },
  };
};
