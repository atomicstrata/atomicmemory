/**
 * @file Mem0 provider adapter. Wraps the SDK MemoryClient configured
 * against the mem0 provider. Common adapter behavior lives in
 * `BaseAdapter`; this class only carries the provider name plus the
 * two capability gates Mem0 surfaces:
 *
 *   - verbatim ingest is rejected (`ingestModes=["text","messages"]`)
 *   - packageContext is rejected (`extensions.package=false`)
 *
 * Both throw `CliError('unsupported_capability')` (exit 2). Command
 * handlers also check capabilities upstream; these are defensive.
 *
 * SDK construction takes a ClientFactory injectable so tests can pass
 * a fake client. defaultMem0ClientFactory uses the SDK Node entrypoint.
 */

import { MemoryClient } from '@atomicmemory/sdk';
import { BaseAdapter } from './base.js';
import { buildClientConfig } from './shared.js';
import type { CliProfileShape } from '../config/schema.js';
import { CliError } from '../types.js';
import type {
  AdapterContextPackage,
  AdapterIngestInput,
  AdapterIngestResult,
  AdapterPackageInput,
} from './types.js';

export type Mem0ClientFactory = (profile: CliProfileShape) => MemoryClient;

const defaultMem0ClientFactory: Mem0ClientFactory = (profile) =>
  new MemoryClient(buildClientConfig(profile, 'mem0'));

interface Mem0AdapterOptions {
  profile: CliProfileShape;
  clientFactory?: Mem0ClientFactory;
}

export class Mem0Adapter extends BaseAdapter {
  readonly providerName = 'mem0' as const;

  constructor(options: Mem0AdapterOptions) {
    if (options.profile.provider !== 'mem0') {
      throw new CliError(
        'usage',
        `Mem0Adapter requires profile.provider="mem0"; got "${options.profile.provider}"`,
      );
    }
    const factory = options.clientFactory ?? defaultMem0ClientFactory;
    super(factory(options.profile));
  }

  override async ingestMemories(
    input: AdapterIngestInput,
  ): Promise<AdapterIngestResult> {
    if (input.mode === 'verbatim') {
      throw new CliError(
        'unsupported_capability',
        'mem0 provider does not support verbatim ingestion (ingestModes=["text","messages"])',
      );
    }
    return super.ingestMemories(input);
  }

  async packageContext(_input: AdapterPackageInput): Promise<AdapterContextPackage> {
    throw new CliError(
      'unsupported_capability',
      'mem0 provider does not support context packaging (extensions.package=false); use --provider atomicmemory or remove the package call',
    );
  }
}
