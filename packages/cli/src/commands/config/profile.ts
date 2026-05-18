/**
 * @file `atomicmemory config profile <list|use|show>` handlers.
 */

import { CliError } from '../../types.js';
import {
  listProfileNames,
  saveConfig,
  setActiveProfile,
  showProfile,
} from '../../config/profiles.js';
import type { CommandHandler } from '../types.js';

export const profileList: CommandHandler<{
  active: string;
  profiles: string[];
}> = async (ctx) => {
  const profiles = listProfileNames(ctx.config);
  return {
    command: 'config profile list',
    data: { active: ctx.config.activeProfile, profiles },
    count: profiles.length,
  };
};

export const profileUse: CommandHandler<{ active: string }> = async (ctx) => {
  const name = ctx.positional[0];
  if (!name) throw new CliError('missing_input', 'config profile use requires a profile name');
  const next = setActiveProfile(ctx.config, name);
  saveConfig(ctx.configPath, ctx.configDir, next);
  return {
    command: 'config profile use',
    data: { active: next.activeProfile },
    count: 1,
  };
};

export const profileShow: CommandHandler<{
  name: string;
  profile: ReturnType<typeof showProfile>;
}> = async (ctx) => {
  const name = ctx.positional[0] ?? ctx.config.activeProfile;
  const profile = showProfile(ctx.config, name);
  return {
    command: 'config profile show',
    data: { name, profile },
    count: 1,
  };
};
