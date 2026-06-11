/**
 * Provider-registration helpers for plugging `LiveLLMWikiProvider` into a
 * `MemoryClient`'s `ProviderRegistry`.
 *
 * Mirrors the shape of `snapshotLlmwikiProviderFactory` in `src/registration.ts` so
 * both snapshot and live providers interoperate with `MemoryClient.initialize(registry)`.
 *
 * Example:
 *
 * ```ts
 * import { MemoryClient } from "@atomicmemory/sdk";
 * import { liveLlmwikiProviderFactory } from "@atomicmemory/llmwiki/live";
 *
 * const client = new MemoryClient({
 *   providers: { llmwiki: { root: "./wiki", scope: { user: "alice" }, projectId: "my-proj" } },
 *   defaultProvider: "llmwiki",
 * });
 * await client.initialize({ llmwiki: liveLlmwikiProviderFactory });
 * ```
 */

import { LiveLLMWikiProvider, type LiveLLMWikiProviderOptions } from "./provider.js";

/**
 * Factory function matching the SDK's `ProviderRegistry` entry contract.
 * Wraps `new LiveLLMWikiProvider(config)` so a registry entry like
 * `{ llmwiki: liveLlmwikiProviderFactory }` interoperates with `MemoryClient.initialize(registry)`.
 */
export function liveLlmwikiProviderFactory(
  config: LiveLLMWikiProviderOptions,
): { provider: LiveLLMWikiProvider } {
  return { provider: new LiveLLMWikiProvider(config) };
}
