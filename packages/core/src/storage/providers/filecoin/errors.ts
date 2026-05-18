/**
 * @file Filecoin provider error hierarchy.
 *
 * Every error thrown out of `src/storage/providers/filecoin/*` extends
 * `FilecoinProviderError` so the route + reconciler layers can pattern
 * match a single base class instead of probing for vendor-shaped
 * variants. Two concrete cases are defined here:
 *
 * - `FilecoinNotImplementedError` — thrown by test-only provider
 *   stubs. The route layer maps it onto a typed envelope so clients
 *   see a stable code.
 * - `FilecoinProviderNotConfiguredError` — thrown at construction
 *   time when the test stub is asked to build a real client without
 *   the operator having supplied the Synapse config (see
 *   `./config.ts`). Surfaces at composition time, not first upload.
 *
 * Sanitization rule: any caller that wraps a vendor (Synapse, RPC,
 * provider) error MUST replace the raw message with the public
 * `errorCode` and discard the original `.message` / `.cause` chain
 * before it crosses this boundary. Wallet addresses, private keys,
 * provider IDs, balances, allowances, and signed-request payloads
 * are not allowed in messages emitted from this module.
 */

export class FilecoinProviderError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'FilecoinProviderError';
    this.errorCode = errorCode;
  }
}

/**
 * Thrown by test-only provider stubs for provider operations
 * (`put`, `get`, `head`, `delete`, `verify`). Carries a public
 * `errorCode` so the route layer can map it onto a stable envelope
 * without inspecting message strings.
 */
export class FilecoinNotImplementedError extends FilecoinProviderError {
  constructor(operation: string) {
    super(
      'filecoin_not_implemented',
      `Filecoin provider operation '${operation}' is not implemented in this build.`,
    );
    this.name = 'FilecoinNotImplementedError';
  }
}

/**
 * Thrown at composition time when `createFilecoinStorageBackend` is
 * called against a config that has not yet been populated with the
 * Synapse fields. This error prevents a half-wired client from being
 * built.
 */
// fallow-ignore-next-line unused-export
export class FilecoinProviderNotConfiguredError extends FilecoinProviderError {
  constructor(reason: string) {
    super('filecoin_provider_not_configured', `Filecoin provider not configured: ${reason}.`);
    this.name = 'FilecoinProviderNotConfiguredError';
  }
}
