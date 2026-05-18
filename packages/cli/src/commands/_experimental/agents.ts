/**
 * @file Hidden experimental `agents` command. Two-stage gated; same
 * shape as lifecycle/audit/lessons.
 */

import type { CommandHandler } from '../types.js';
import { gate } from './gate.js';

export const agents: CommandHandler<{
  surface: 'agents';
  experimental: true;
  customExtension: string;
}> = async (ctx) => {
  const { capabilities } = await ctx.getAdapter();
  gate(ctx, 'agents', capabilities);
  return {
    command: 'agents',
    data: {
      surface: 'agents',
      experimental: true,
      customExtension: 'atomicmemory.agents',
    },
    count: 1,
    meta: { experimental: true },
  };
};
