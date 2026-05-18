/**
 * @file Hidden experimental `lifecycle` command. Two-stage gated; if the
 * gate passes, the handler returns a thin diagnostic summary based on
 * provider capabilities. The full lifecycle command surface (stats/cap
 * actions etc.) lands once the AtomicMemory SDK exposes a stable shape
 * — until then we expose only the gate result so the command contract
 * is testable and machine-checkable from V1 onward.
 */

import type { CommandHandler } from '../types.js';
import { gate } from './gate.js';

export const lifecycle: CommandHandler<{
  surface: 'lifecycle';
  experimental: true;
  customExtension: string;
}> = async (ctx) => {
  const { capabilities } = await ctx.getAdapter();
  gate(ctx, 'lifecycle', capabilities);
  return {
    command: 'lifecycle',
    data: {
      surface: 'lifecycle',
      experimental: true,
      customExtension: 'atomicmemory.lifecycle',
    },
    count: 1,
    meta: { experimental: true },
  };
};
