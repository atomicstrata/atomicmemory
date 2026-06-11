# Offline Personal Profile

This document specifies the exact environment configuration for running
AtomicMemory Core with **zero external network calls** — no OpenAI, no Voyage,
no HuggingFace Hub fetch at runtime. This is the supported profile for
Radar Personal deployments that must operate fully air-gapped or on networks
without cloud API access.

## No-External-Calls Guarantee

When the configuration below is applied:

- Embeddings are computed locally by the `transformers` provider (ONNX Runtime
  via `@huggingface/transformers`). No request is ever sent to `api.openai.com`,
  `api.voyageai.com`, or any other external embedding endpoint.
- Ingest uses `/ingest/quick?skip_extraction=true`, which stores the caller's
  pre-extracted facts directly without invoking any LLM CLI. No `claude-code`,
  `codex`, or other LLM process is spawned.
- The database is local Postgres + pgvector (Docker image uses an embedded
  instance by default).

**In this profile, the AtomicMemory Core server makes NO external network
calls during normal operation.**

> Note: the model weights themselves must be downloaded once before the first
> run (see Pre-cache step below). After pre-caching, no network access is
> needed for any subsequent start or request.

## Exact Environment Combo

```env
# Offline Personal profile — zero external network calls

# Local ONNX embeddings (no API key required)
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
EMBEDDING_DIMENSIONS=384

# Offline mode guard: rejects cloud embedding AND cloud LLM providers at startup
OFFLINE_MODE=true

# A local LLM_PROVIDER is REQUIRED under OFFLINE_MODE=true. The default
# LLM_PROVIDER is `openai` (a cloud provider), so it must be set explicitly to
# a local provider even if you only use the zero-LLM quick-ingest path —
# otherwise startup fails fast. Allowed local LLM providers:
#   LLM_PROVIDER=claude-code   # uses local Claude Code CLI, no Anthropic API key
#   LLM_PROVIDER=codex         # uses local Codex CLI, no OpenAI API key
#   LLM_PROVIDER=ollama        # uses a local Ollama daemon only
LLM_PROVIDER=claude-code

# Local Postgres + pgvector (Docker image embeds one by default)
DATABASE_URL=postgresql://atomicmemory:atomicmemory@localhost:5433/atomicmemory

# Raw-content policy: single-user local deployments may allow any content class
RAW_CONTENT_POLICY=allow

# Required at startup
CORE_API_KEY=replace-with-a-strong-random-secret
STORAGE_KEY_HMAC_SECRET=<64-hex-chars>
RAW_STORAGE_DEPLOYMENT_ENV=local
```

## Pre-cache Step

The `transformers` provider downloads the ONNX model from HuggingFace Hub on
the **first run** only, then stores it in a local cache directory. Subsequent
starts and all inference use only the cached files — no network access.

To pre-download the model **before** going offline:

```bash
# Set the cache directory (optional — defaults to the HuggingFace transformers
# cache, typically ~/.cache/huggingface/hub or $HF_HOME/hub).
export TRANSFORMERS_CACHE=/path/to/your/model-cache

# Run a one-shot embed to trigger the download (any non-empty string works):
curl -s -X POST http://localhost:17350/v1/memories/search \
  -H "Authorization: Bearer $CORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"warmup","user_id":"warmup"}' \
  | head -c 200
```

Alternatively, use the HuggingFace CLI to download the model files directly:

```bash
pip install huggingface_hub
huggingface-cli download Xenova/all-MiniLM-L6-v2 \
  --local-dir /path/to/your/model-cache/Xenova/all-MiniLM-L6-v2
```

After the cache is populated, the server can be started without any internet
access and will serve the model from the local cache on every run.

> **Do not commit ONNX model weights.** Model files are large binary artifacts
> that belong in ops-managed storage (Docker volume, persistent disk, etc.),
> not in the repository. The cache directory should be in `.gitignore`.

## Zero-LLM Ingest Path

The `/ingest/quick?skip_extraction=true` endpoint accepts pre-extracted facts
and stores them directly without invoking any LLM. This is the primary ingest
path for the Offline Personal profile.

```bash
curl -X POST "http://localhost:17350/v1/memories/ingest/quick?skip_extraction=true" \
  -H "Authorization: Bearer $CORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-123",
    "memories": [
      { "content": "The project deadline is end of Q3." }
    ]
  }'
```

The full `/ingest` endpoint (which calls an extraction LLM to produce memories
from raw conversation text) requires a local LLM CLI when offline:

- `LLM_PROVIDER=claude-code` — uses the local [Claude Code](https://claude.ai/code)
  CLI. No `ANTHROPIC_API_KEY` is required; the CLI handles auth locally.
- `LLM_PROVIDER=codex` — uses the local [Codex](https://openai.com/blog/openai-codex)
  CLI. No `OPENAI_API_KEY` is required; the CLI handles auth locally.

## Offline Mode Guard

Setting `OFFLINE_MODE=true` adds a startup validation step that rejects **both**
the `EMBEDDING_PROVIDER` and the `LLM_PROVIDER` if either would make external
network calls. The LLM provider matters because the full `/v1/memories/ingest`
extraction path calls the LLM provider — a cloud LLM under offline mode would
silently reach a cloud API. This ensures a misconfigured offline deployment
fails fast at startup with a clear error message rather than degrading into
cloud calls when the first request arrives.

> The default `LLM_PROVIDER` is `openai` (cloud). Under `OFFLINE_MODE=true` you
> MUST set `LLM_PROVIDER` explicitly to a local provider — even on the
> zero-LLM `skip_extraction=true` quick-ingest path — or startup fails.

Accepted embedding providers under `OFFLINE_MODE=true`:

| Provider | Network calls |
|---|---|
| `transformers` | None after model is pre-cached |
| `ollama` | None (calls local Ollama daemon only) |

Rejected embedding providers under `OFFLINE_MODE=true`:

| Provider | Rejected because |
|---|---|
| `openai` | Calls `api.openai.com` |
| `voyage` | Calls `api.voyageai.com` |
| `openai-compatible` | Calls a configurable remote endpoint |

Accepted LLM providers under `OFFLINE_MODE=true`:

| Provider | Network calls |
|---|---|
| `claude-code` | None (local Claude Code CLI handles auth locally) |
| `codex` | None (local Codex CLI handles auth locally) |
| `ollama` | None (calls local Ollama daemon only) |

Rejected LLM providers under `OFFLINE_MODE=true`:

| Provider | Rejected because |
|---|---|
| `openai` | Calls `api.openai.com` |
| `anthropic` | Calls `api.anthropic.com` |
| `groq` | Calls `api.groq.com` |
| `google-genai` | Calls Google Generative AI endpoints |
| `openai-compatible` | Calls a configurable remote endpoint |

## Summary

| Concern | Offline Personal setting |
|---|---|
| Embedding | `EMBEDDING_PROVIDER=transformers` + `EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2` + `EMBEDDING_DIMENSIONS=384` |
| LLM (ingest) | `LLM_PROVIDER=claude-code` / `codex` / `ollama` (required — cloud default is rejected offline) |
| Model weights | Pre-cache once to `TRANSFORMERS_CACHE`; not committed to the repo |
| Database | Local Postgres + pgvector |
| Content policy | `RAW_CONTENT_POLICY=allow` (single-user local) |
| Startup guard | `OFFLINE_MODE=true` — fails fast if a cloud embedding OR cloud LLM provider is configured |
| External calls | **None** after model pre-cache |
