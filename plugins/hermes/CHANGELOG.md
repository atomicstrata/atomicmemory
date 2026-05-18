# Changelog

## 0.1.13 - 2026-05-15

### Fixed

- Installer now writes the provider to `$HERMES_HOME/plugins/atomicmemory/`, the path Hermes actually scans for user-installed memory providers. Previously the files landed under `$HERMES_HOME/plugins/memory/atomicmemory/`, where Hermes' discovery never looked, so `hermes memory setup` did not list AtomicMemory as a choice.
- Normalized the npm `bin` path in `package.json` so the binary resolves on platforms that reject the `./install.mjs` form.

## 0.1.12 - 2026-05-14

### Fixed

- Added the Core Quickstart bearer key to the installer next-step output so the published package matches the local quickstart docs.

## 0.1.11 - 2026-05-14

### Added

- Added the packaged Hermes provider installer exposed through the `atomicmemory-hermes` npm binary.

### Fixed

- Preserved the Python SDK import path when Hermes is installed from the packaged npm artifact.

## 0.1.10 - 2026-05-14

### Added

- Initial public npm package for the AtomicMemory Hermes plugin.
