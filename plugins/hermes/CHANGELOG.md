# Changelog

## 0.2.0 - 2026-07-29

### Changed

- **Breaking (tool contract):** `atomicmemory_conclude` now requires a `content_class` parameter (`summary`, `redacted`, or `raw`) describing the sensitivity of the text being stored. A call that omits it, or passes an unrecognized value, is rejected at the tool boundary with a message naming the parameter.

  This is required to store facts against AtomicMemory Core 1.2.0 and later. Core defaults to `RAW_CONTENT_POLICY=reject`, which refuses a verbatim write carrying no content class — previously `conclude` sent an unclassified write and received `422 raw_content_rejected`, with nothing indicating which tool call caused it. The class is never chosen on the caller's behalf: guessing it could label a raw transcript as hosted-safe.

  Existing deployments need no configuration change, but a model that calls `conclude` without the new parameter will get a tool error instead of a stored fact until it adapts.

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
