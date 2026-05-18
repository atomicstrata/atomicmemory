/**
 * @file Capability and experimental-mode gates. Per v5 §"Provider
 * Adapter": commands assert capabilities BEFORE invoking the adapter
 * method; failures yield CliError('unsupported_capability') exit 2.
 *
 * Hidden experimental commands additionally pass through
 * assertExperimentalEnabled, which yields exit 2 `experimental_disabled`
 * when --experimental was not on the parsed flags. This module owns
 * neither flag parsing nor adapter construction; it just validates
 * inputs and throws.
 */

import { CliError, type ProviderCapabilities } from './types.js';

/**
 * Path into ProviderCapabilities. Two shapes:
 *   - "extensions.<name>"            (e.g. "extensions.package")
 *   - "customExtensions.<dotted>"    (e.g. "customExtensions.atomicmemory.lifecycle")
 *
 * The literal "ingestModes.verbatim" form is also accepted to gate
 * verbatim ingestion against providers that only advertise text/messages.
 */
type CapabilityPath =
  | `extensions.${string}`
  | `customExtensions.${string}`
  | `ingestModes.${'text' | 'messages' | 'verbatim'}`;

export function assertCapability(
  capabilities: ProviderCapabilities,
  path: CapabilityPath,
  context?: string,
): void {
  if (hasCapability(capabilities, path)) return;
  const where = context ? ` (${context})` : '';
  throw new CliError(
    'unsupported_capability',
    `provider does not support "${path}"${where}`,
  );
}

export function hasCapability(
  capabilities: ProviderCapabilities,
  path: CapabilityPath,
): boolean {
  if (path.startsWith('extensions.')) {
    const name = path.slice('extensions.'.length);
    return capabilities.extensions[name] === true;
  }
  if (path.startsWith('customExtensions.')) {
    const name = path.slice('customExtensions.'.length);
    return Boolean(capabilities.customExtensions?.[name]);
  }
  // ingestModes.<mode>
  const mode = path.slice('ingestModes.'.length) as
    | 'text'
    | 'messages'
    | 'verbatim';
  return capabilities.ingestModes.includes(mode);
}

/**
 * Reranker gate — a `--reranker <name>` flag is only honored when the
 * provider's `supportedRerankers` list advertises that exact name.
 * Throws unsupported_capability on mismatch.
 */
export function assertReranker(
  capabilities: ProviderCapabilities,
  name: string,
): void {
  const supported = capabilities.supportedRerankers ?? [];
  if (supported.includes(name)) return;
  const list = supported.length > 0 ? supported.join(', ') : '(none)';
  throw new CliError(
    'unsupported_capability',
    `reranker "${name}" is not supported by the active provider; available: ${list}`,
  );
}

/**
 * Hidden experimental commands run a two-stage gate:
 *   1. assertExperimentalEnabled  -> CliError('experimental_disabled')
 *   2. assertCapability(adapter, exact-extension-name)
 * This module owns step 1; step 2 is a normal capability assertion via
 * assertCapability/hasCapability above.
 */
export function assertExperimentalEnabled(flags: {
  experimental?: boolean;
}): void {
  if (flags.experimental === true) return;
  throw new CliError(
    'experimental_disabled',
    'this command is experimental and requires --experimental to invoke',
  );
}
