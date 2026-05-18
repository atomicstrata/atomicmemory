/**
 * @file `atomicmemory config set <key> <value>` — set one non-secret
 * value. apiKey writes are forbidden here (use `init --api-key-stdin
 * --save-api-key`); secrets must not be passed via positional argv.
 */

import { CliError } from '../../types.js';
import { saveConfig } from '../../config/profiles.js';
import { CliConfigSchema, type CliConfigShape } from '../../config/schema.js';
import type { CommandHandler } from '../types.js';

export const set: CommandHandler<{ key: string; value: string }> = async (
  ctx,
) => {
  const key = ctx.positional[0];
  const value = ctx.positional[1];
  if (!key || value === undefined) {
    throw new CliError(
      'missing_input',
      'config set requires both key and value',
    );
  }
  if (key.endsWith('apiKey')) {
    throw new CliError(
      'usage',
      'apiKey cannot be set via `config set`; use `init --api-key-stdin --save-api-key`',
    );
  }
  const next = applySet(ctx.config, key, value);
  CliConfigSchema.parse(next);
  saveConfig(ctx.configPath, ctx.configDir, next);
  return {
    command: 'config set',
    data: { key, value },
    count: 1,
  };
};

function applySet(config: CliConfigShape, path: string, value: string): CliConfigShape {
  const segments = path.split('.');
  const next = JSON.parse(JSON.stringify(config)) as CliConfigShape;
  let cursor: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const child = cursor[segment];
    if (child == null || typeof child !== 'object') {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
  return next;
}
