/**
 * @file Hidden experimental `lessons` command. Two-stage gated; same
 * shape as lifecycle/audit/agents.
 */

import type { CommandHandler } from '../types.js';
import { gate } from './gate.js';

export const lessons: CommandHandler<{
  surface: 'lessons';
  experimental: true;
  customExtension: string;
}> = async (ctx) => {
  const { capabilities } = await ctx.getAdapter();
  gate(ctx, 'lessons', capabilities);
  return {
    command: 'lessons',
    data: {
      surface: 'lessons',
      experimental: true,
      customExtension: 'atomicmemory.lessons',
    },
    count: 1,
    meta: { experimental: true },
  };
};
