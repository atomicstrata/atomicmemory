/**
 * @file `atomicmemory config show` — show merged config with secrets
 * redacted. Adapter-free.
 */

import {
  REDACTED_API_KEY,
} from '../../config/profiles.js';
import type { CliConfigShape } from '../../config/schema.js';
import type { CommandHandler } from '../../commands/types.js';

export const show: CommandHandler<CliConfigShape> = async (ctx) => {
  const redacted = redactConfig(ctx.config);
  return {
    command: 'config show',
    data: redacted,
    count: Object.keys(redacted.profiles).length,
  };
};

function redactConfig(config: CliConfigShape): CliConfigShape {
  const profiles: CliConfigShape['profiles'] = {};
  for (const [name, p] of Object.entries(config.profiles)) {
    profiles[name] = p.apiKey ? { ...p, apiKey: REDACTED_API_KEY } : p;
  }
  return { ...config, profiles };
}
