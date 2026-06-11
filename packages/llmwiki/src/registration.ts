/**
 * Provider-registration helpers for plugging `SnapshotLLMWikiProvider` into a
 * `MemoryClient`'s `ProviderRegistry`.
 *
 * The SDK's `MemoryClient` accepts a registry parameter to
 * `initialize()`. Pass `{ ...defaultRegistry, llmwiki:
 * snapshotLlmwikiProviderFactory }` plus a matching `providers.llmwiki`
 * config block to wire the bridge in as a queryable provider.
 *
 * Example:
 *
 * ```ts
 * import { MemoryClient } from "@atomicmemory/sdk";
 * import { defaultRegistry } from "@atomicmemory/sdk/internal";
 * import { snapshotLlmwikiProviderFactory, loadLLMWikiExport } from "@atomicmemory/llmwiki";
 *
 * const exportData = await loadLLMWikiExport("./wiki.json");
 * const client = new MemoryClient({
 *   providers: { llmwiki: { exportData, scope: { user: "alice" } } },
 *   defaultProvider: "llmwiki",
 * });
 * await client.initialize({ ...defaultRegistry, llmwiki: snapshotLlmwikiProviderFactory });
 * ```
 *
 * `defaultRegistry` is internal-ish on the SDK; users who prefer
 * not to import it can construct a registry with `llmwiki:
 * snapshotLlmwikiProviderFactory` alone.
 */

import { SnapshotLLMWikiProvider, type SnapshotLLMWikiProviderOptions } from "./provider.js";

/**
 * Factory function shape matching the SDK's `ProviderRegistry`
 * entry contract. Wraps `new SnapshotLLMWikiProvider(options)` so a registry
 * record entry like `llmwiki: snapshotLlmwikiProviderFactory` interoperates
 * with `MemoryClient.initialize(registry)`.
 */
export function snapshotLlmwikiProviderFactory(
  config: SnapshotLLMWikiProviderOptions,
): { provider: SnapshotLLMWikiProvider } {
  return { provider: new SnapshotLLMWikiProvider(config) };
}

