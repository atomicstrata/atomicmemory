/**
 * Capability check: refuse to import unless the chosen provider
 * supports `verbatim` ingest.
 *
 * A `text` fallback is NOT acceptable: text-mode may re-extract and
 * may drop the bridge metadata depending on the provider. The
 * adapter MUST refuse before any side effects when no routable
 * provider supports verbatim.
 *
 * **This is a contract-trust check, not an end-to-end verification.**
 * We inspect the provider's advertised `capabilities().ingestModes`;
 * we do NOT round-trip a record and read it back to confirm the
 * persisted shape carries a verbatim provenance marker. A provider
 * that advertises verbatim and silently routes to text-mode
 * internally (e.g. some composite stacks) would slip through. The
 * end-to-end smoke test under `tests/smoke/` is the integration-side
 * complement to this contract check.
 *
 * Composite-stack routing (preferring the verbatim-capable provider
 * in a multi-provider stack) is intentionally NOT here — the caller
 * passes one provider, and the adapter only enforces that *whatever*
 * it's pointed at supports verbatim. Stack routing is a user-code
 * concern.
 */

import type { MemoryProvider } from "@atomicmemory/sdk";
import { E_LLMWIKI_VERBATIM_UNSUPPORTED, LLMWikiBridgeError } from "./errors.js";

/**
 * Pure predicate over a list of ingest modes. Exposed so CLI callers
 * (which cannot import the SDK provider type) can reuse the gate
 * logic without re-implementing it. Always pass `capabilities.ingestModes`.
 */
export function supportsVerbatim(ingestModes: readonly string[]): boolean {
  return ingestModes.includes("verbatim");
}

/**
 * Canonical error message body for "provider doesn't support
 * verbatim." Used by both the SDK-side `assertSupportsVerbatim` and
 * the CLI handler so the two messages stay in sync.
 */
export function verbatimUnsupportedMessage(providerName: string): string {
  return (
    `Provider "${providerName}" does not support verbatim ingest. ` +
    "The llmwiki bridge requires verbatim mode so compiled wiki pages survive " +
    "as one-record-per-page with their advisory metadata intact."
  );
}

export function assertSupportsVerbatim(provider: MemoryProvider): void {
  const caps = provider.capabilities();
  if (!supportsVerbatim(caps.ingestModes)) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_VERBATIM_UNSUPPORTED,
      verbatimUnsupportedMessage(provider.name),
    );
  }
}
