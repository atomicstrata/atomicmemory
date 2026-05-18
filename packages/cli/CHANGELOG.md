# Changelog

## 0.1.1 - 2026-05-14

### Fixed

- Fixed interactive dashboard commands reusing a provider-free startup state after launching from a bare `atomicmemory` invocation. Dashboard sessions now hydrate the saved profile and scope at startup, while plain provider-free commands such as `atomicmemory help` remain provider-free.

## 0.1.0 - 2026-05-14

### Added

- Initial public release of the AtomicMemory CLI.
