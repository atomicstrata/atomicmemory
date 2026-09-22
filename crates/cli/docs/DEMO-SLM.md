# `am slm` demo (Apple Silicon / M5) — ATO-1936

**Apple Silicon macOS only.** No Polar. No `OPENAI_API_KEY` for SLM mode.

Public contract: `https://get.atomicstrata.ai/am-slm/version.json` (**0.1.1**).

## One-shot Connected Local (cold start)

From a machine with no prior SLM install, this bootstraps the binary, pulls
Qwen + Nomic + `am-slm-core` (~1.7GB, requires `--yes` or a prompt), starts
host Metal SLM on `:8080`, and starts Core Docker with the SLM overlay:

```bash
am init --local --slm --yes
```

## SLM-only path (install → status → start)

```bash
# From repo root (workspace package name is `atomicmemory`, binary `am`):
cargo build --release -p atomicmemory
export AM=./target/release/am

$AM slm install
$AM -o json slm status

$AM slm start --yes
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/v1/models
# expect ids: am-slm-core + nomic-embed-text

$AM slm stop
```

`am slm start` installs the runtime if missing and pulls the start-complete
model set when the cache is empty (`--yes` or a prompt). To pull without
starting:

```bash
$AM slm models pull --yes    # Qwen + Nomic + am-slm-core; never silent
$AM slm models status
```

Fail-closed on non-Apple-Silicon, checksum mismatch, or unreachable R2.

## Connected Local Core (`--slm`)

Starts host Metal SLM first, then Core with openai-compatible env at
`http://host.docker.internal:8080/v1` (`LLM_MODEL=am-slm-core`,
`EMBEDDING_MODEL=nomic-embed-text`, `EMBEDDING_DIMENSIONS=768`). No OpenAI key.


Default Connected Local extract contract (required for Playground Full ingest
against today's published Core image):

- Host `am-slm serve`: `AM_SLM_CORE_JSON_SCHEMA=1` only (full extraction grammar)
- **Not** set: `AM_SLM_CORE_COMPACT_SCHEMA` or Core `EXTRACTION_PROMPT_VARIANT=compact`
  (current `ghcr.io/atomicstrata/atomicmemory-core:latest` has no compact prompt —
  compact deferred until that image ships)

`am slm start` and `am instance start --slm` set `AM_SLM_CORE_JSON_SCHEMA=1`
automatically. If a CLI-managed SLM is already running without that flag, start
restarts it. An external (non-managed) listener without the flag fails loudly —
stop it and re-run managed start, or export `AM_SLM_CORE_JSON_SCHEMA=1` yourself.

After pulling this branch onto a machine that already had `am-slm` running,
restart the host SLM once so the JSON-schema env applies (Core recreate alone
is not enough; a prior compact-schema process must be restarted):

```bash
$AM slm stop && $AM slm start --yes

# Existing local profile:
$AM instance start --slm --yes
# Migrating from an OpenAI / 1536-dim Core volume (explicit wipe only):
# $AM instance start --slm --slm-reset-data --yes
```

If an old Core is already up, `--slm` recreates the managed container so the
SLM overlay env applies; `--slm-reset-data` stops/removes Core first, then
wipes `atomic-memory-data` / `atomic-memory-state` volumes.

Core default URL: `:17350` (`am instance status`).

## Doctor / uninstall

```bash
$AM doctor
$AM slm uninstall            # keeps model cache
# $AM slm uninstall --purge-models
```
