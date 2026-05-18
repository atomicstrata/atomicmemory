# Changelog

All notable changes to `@atomicmemory/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
