/**
 * @file `atomicmemory config get <key>` — read one config value.
 * Supports dotted paths (e.g., "profiles.default.apiUrl"). Adapter-free.
 */

import { CliError } from '../../types.js';
import type { CommandHandler } from '../types.js';
import { REDACTED_API_KEY } from '../../config/profiles.js';

export const configGet: CommandHandler<{ key: string; value: unknown }> = async (
  ctx,
) => {
  const key = ctx.positional[0];
  if (!key) {
    throw new CliError('missing_input', 'config get requires a key');
  }
  const value = lookup(ctx.config as unknown as Record<string, unknown>, key);
  const redacted = key.endsWith('apiKey') && typeof value === 'string'
    ? REDACTED_API_KEY
    : value;
  return {
    command: 'config get',
    data: { key, value: redacted },
    count: value === undefined ? 0 : 1,
  };
};

function lookup(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, obj);
}
