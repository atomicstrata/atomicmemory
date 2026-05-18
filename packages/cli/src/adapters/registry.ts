/**
 * @file Provider adapter registry. Phase 5 audit found that any module
 * that statically imports this registry transitively triggers an SDK
 * import (atomicmemory.ts / mem0.ts → @atomicmemory/sdk),
 * which executes the SDK's eager transformers-env logger and
 * pollutes stdout BEFORE the CLI's renderer writes its envelope. To
 * keep `--json version`, `--agent version`, and other non-provider
 * commands clean, this module must NOT statically import the adapter
 * implementations. Both branches use `await import(...)` so the SDK
 * is only loaded when a provider command actually reaches for it.
 *
 * `getAdapter` is now async. Phase 4's tests that called it
 * synchronously have been updated alongside this change.
 */

import type { CliProfileShape } from '../config/schema.js';
import { CliError } from '../types.js';
import type { ClientFactory as AtomicMemoryClientFactory } from './atomicmemory.js';
import type { Mem0ClientFactory } from './mem0.js';
import type { ProviderAdapter } from './types.js';

interface AdapterFactories {
  atomicmemory?: AtomicMemoryClientFactory;
  mem0?: Mem0ClientFactory;
}

export async function getAdapter(
  profile: CliProfileShape,
  factories: AdapterFactories = {},
): Promise<ProviderAdapter> {
  switch (profile.provider) {
    case 'atomicmemory': {
      const { AtomicMemoryAdapter } = await import('./atomicmemory.js');
      return new AtomicMemoryAdapter({
        profile,
        ...(factories.atomicmemory
          ? { clientFactory: factories.atomicmemory }
          : {}),
      });
    }
    case 'mem0': {
      const { Mem0Adapter } = await import('./mem0.js');
      return new Mem0Adapter({
        profile,
        ...(factories.mem0 ? { clientFactory: factories.mem0 } : {}),
      });
    }
    default: {
      const exhaustive: never = profile.provider;
      throw new CliError(
        'usage',
        `unknown provider in profile: "${String(exhaustive)}"`,
      );
    }
  }
}
