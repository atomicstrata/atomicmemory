/**
 * @file Hidden experimental `audit` command. Two-stage gated; same
 * shape as the lifecycle/lessons/agents commands. See gate.ts for the
 * gate contract; full audit surface lands when the SDK exposes a
 * stable AtomicMemory audit shape.
 */

import type { CommandHandler } from '../types.js';
import { gate } from './gate.js';

export const audit: CommandHandler<{
  surface: 'audit';
  experimental: true;
  customExtension: string;
}> = async (ctx) => {
  const { capabilities } = await ctx.getAdapter();
  gate(ctx, 'audit', capabilities);
  return {
    command: 'audit',
    data: {
      surface: 'audit',
      experimental: true,
      customExtension: 'atomicmemory.audit',
    },
    count: 1,
    meta: { experimental: true },
  };
};
