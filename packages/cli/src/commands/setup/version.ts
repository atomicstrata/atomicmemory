/**
 * @file `atomicmemory version` — print CLI version. Adapter-free.
 */

import type { CommandHandler } from '../types.js';

export const version: CommandHandler<{ version: string }> = async (ctx) => {
  return {
    command: 'version',
    data: { version: ctx.version },
    count: 1,
  };
};
