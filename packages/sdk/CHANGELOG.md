# Changelog

All notable changes to `@atomicmemory/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Support `new MemoryClient()` with AtomicMemory Cloud defaults and
  `ATOMICMEMORY_API_KEY` in Node server contexts. Explicit credentials and providers
  take precedence, and local or custom endpoints never inherit the environment key.
- Require nonblank Cloud credentials and reject the local Core development key
  before Cloud requests. Preserve explicit browser credentials without a `process`
  global and remove the Node-only URL validation import so browsers can bundle.

### Added
- Optional `AbortSignal` on generic ingest and search requests for AtomicMemory
  and Mem0. Existing method signatures and successful response shapes remain
  source-compatible. Hindsight does not honor this option.

### Fixed
- Compose caller cancellation with the provider's configured HTTP timeout.
- Reject AtomicMemory HTTP 202 ingest responses with `PendingIngestError`,
  including namespace full and quick ingestion, even when the response has IDs.
  Accepted writes are not reported as completed. No polling or terminal receipts
  are added, and cancellation cannot undo server-side writes.

## [1.1.1] - 2026-06-16

### Security
- Hardened client configuration validation. Upgrade recommended.

## [1.0.1] - 2026-05-14

### Changed
- Version bump for public package publication after repository metadata sync.

## [1.0.0]

Initial public release.

### Added
- `MemoryClient` — the primary public surface (`ingest`, `search`, `package`, `get`, `list`, `delete`).
- `MemoryProvider` interface, `BaseMemoryProvider`, and the provider registry.
- `AtomicMemoryProvider` — HTTP adapter for [@atomicmemory/core](../core).
- `Mem0Provider` — HTTP adapter for [Mem0](https://github.com/mem0ai/mem0) (OSS and hosted modes).
- `StorageManager` with IndexedDB and in-memory adapters, validation, and resilience.
- `EmbeddingGenerator` — transformers.js-backed local embeddings.
- `SemanticSearch` — cosine-similarity search primitives.
- Error types (`AtomicMemoryError`, `StorageError`, `EmbeddingError`, `SearchError`, `ConfigurationError`, `NetworkError`) and a minimal event emitter.
- Subpath exports: `./browser`, `./storage`, `./embedding`, `./search`, `./utils`, `./core`, `./memory`.
