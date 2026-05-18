/**
 * @file Handler entry for `atomicmemory hooks`. It dispatches between
 * install-plan rendering and the bundled Node hook runtime.
 */

import type { CommandHandler } from '../../types.js';
import { installPlan } from './install.js';
import { runHook } from './run.js';
import { parseAction, type HooksResult } from './types.js';

export const hooks: CommandHandler<HooksResult> = async (ctx) => {
  const action = parseAction(ctx.positional[0]);
  if (action === 'install') return installPlan(ctx);
  return runHook(ctx);
};
