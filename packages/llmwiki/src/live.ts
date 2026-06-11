/**
 * `@atomicmemory/llmwiki/live` — the WRITABLE, source-backed provider. Importing this entrypoint
 * (and only this one) pulls in the heavy `llm-wiki-compiler` SDK; the root barrel never does.
 *
 * Re-exports the full live surface:
 * - `LiveLLMWikiProvider` + `LiveLLMWikiProviderOptions` — the provider class and its construction options
 * - `liveLlmwikiProviderFactory` — registry-compatible factory (mirrors `snapshotLlmwikiProviderFactory`)
 * - External-id utilities for live source memories
 * - Metadata helpers for mapping SourceRecords to AtomicMemory Memory objects
 */
export { LiveLLMWikiProvider, type LiveLLMWikiProviderOptions } from "./live/provider.js";
export { liveLlmwikiProviderFactory } from "./live/registration.js";
export { buildLiveExternalId, parseLiveExternalId, LIVE_EXTERNAL_ID_PREFIX } from "./live/live-external-id.js";
export { sourceToMemory, buildLiveSourceMetadata } from "./live/live-metadata.js";
