/**
 * @file `atomicmemory get <id>` — fetch one memory. Not-found returns
 * exit 4 per v5 §"Output Semantics".
 */

import { CliError } from '../../types.js';
import type { AdapterMemorySummary } from '../../adapters/types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';

export const get: CommandHandler<AdapterMemorySummary> = async (ctx) => {
  const id = ctx.positional[0];
  if (!id) throw new CliError('missing_input', 'get requires a memory id');
  const scope = requireScope(ctx);
  const { adapter, capabilities } = await ctx.getAdapter();
  requireDynamicScope(ctx, 'get', capabilities);
  const memory = await adapter.getMemory({ id, scope });
  if (!memory) {
    throw new CliError('not_found', `memory not found: ${id}`);
  }
  return {
    command: 'get',
    data: memory,
    count: 1,
  };
};
