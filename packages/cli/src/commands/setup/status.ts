/**
 * @file `atomicmemory status` — concise active-provider/profile/scope/
 * capabilities snapshot. Used by both humans and agents.
 */

import { CliError } from '../../types.js';
import type { AdapterStatus } from '../../adapters/types.js';
import type { CliScopePartial, ProviderCapabilities } from '../../types.js';
import type { CommandHandler } from '../types.js';

export const status: CommandHandler<{
  provider: string;
  profile: string;
  trustSurface: string;
  scope: CliScopePartial;
  status: AdapterStatus;
  capabilities: Pick<
    ProviderCapabilities,
    'ingestModes' | 'extensions' | 'maxTokenBudget' | 'supportedRerankers'
  >;
}> = async (ctx) => {
  if (!ctx.profile) {
    throw new CliError(
      'usage',
      'status needs a configured profile; run `atomicmemory init` or pass --provider and --api-url',
    );
  }
  const { adapter, capabilities } = await ctx.getAdapter();
  const adapterStatus = await adapter.getStatus();
  return {
    command: 'status',
    data: {
      provider: ctx.profile.provider,
      profile: ctx.config.activeProfile,
      trustSurface: ctx.profile.trustSurface,
      scope: ctx.scope,
      status: adapterStatus,
      capabilities: {
        ingestModes: capabilities.ingestModes,
        extensions: capabilities.extensions,
        ...(capabilities.maxTokenBudget !== undefined
          ? { maxTokenBudget: capabilities.maxTokenBudget }
          : {}),
        ...(capabilities.supportedRerankers
          ? { supportedRerankers: capabilities.supportedRerankers }
          : {}),
      },
    },
    count: 1,
  };
};
