/**
 * @file `atomicmemory config unset <key>` — remove one config value.
 */

import { CliError } from '../../types.js';
import { saveConfig } from '../../config/profiles.js';
import { CliConfigSchema, type CliConfigShape } from '../../config/schema.js';
import type { CommandHandler } from '../types.js';

export const unset: CommandHandler<{ key: string; removed: boolean }> = async (
  ctx,
) => {
  const key = ctx.positional[0];
  if (!key) throw new CliError('missing_input', 'config unset requires a key');

  const segments = key.split('.');
  const next = JSON.parse(JSON.stringify(ctx.config)) as CliConfigShape;
  let cursor: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const child = cursor[segment];
    if (child == null || typeof child !== 'object') {
      return {
        command: 'config unset',
        data: { key, removed: false },
        count: 0,
      };
    }
    cursor = child as Record<string, unknown>;
  }
  const last = segments[segments.length - 1]!;
  const removed = last in cursor;
  delete cursor[last];
  CliConfigSchema.parse(next);
  if (removed) {
    saveConfig(ctx.configPath, ctx.configDir, next);
  }
  return {
    command: 'config unset',
    data: { key, removed },
    count: removed ? 1 : 0,
  };
};
