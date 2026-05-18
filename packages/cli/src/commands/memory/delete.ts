/**
 * @file `atomicmemory delete <id>` — delete one memory. Not-found
 * returns exit 4 (provider get followed by delete to surface the
 * not_found case before the destructive call).
 */

import { CliError } from '../../types.js';
import type { CommandHandler } from '../types.js';
import { requireDynamicScope, requireScope } from '../scope.js';

export const deleteCommand: CommandHandler<{ id: string; deleted: true }> = async (ctx) => {
  const id = ctx.positional[0];
  if (!id) throw new CliError('missing_input', 'delete requires a memory id');
  const scope = requireScope(ctx);
  const { adapter, capabilities } = await ctx.getAdapter();
  requireDynamicScope(ctx, 'delete', capabilities);

  const memory = await adapter.getMemory({ id, scope });
  if (!memory) {
    throw new CliError('not_found', `memory not found: ${id}`);
  }
  await adapter.deleteMemory({ id, scope });
  return {
    command: 'delete',
    data: { id, deleted: true },
    count: 1,
  };
};
