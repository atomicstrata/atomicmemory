"""SDK boundary: the single place that touches the `atomicmemory` SDK.

lfx-free. Components call this bridge; the bridge passes plain dicts to the SDK
client (the client coerces them into validated Pydantic requests). A
``client_factory`` hook lets tests inject a fake client.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "http://localhost:17350"
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}

# Phase 1 supports only the atomicmemory provider end-to-end.
SUPPORTED_PROVIDERS = frozenset({"atomicmemory"})

# provider_config is ALLOWLIST-only: just harmless SDK tuning keys. Anything else —
# including any secret/connection-shaped key (accessToken, clientSecret, headers,
# authorization, …) — is rejected. Secrets and the URL belong in the dedicated
# 'API Key' / 'API URL' fields, never in the plaintext-persisted provider_config.
_ALLOWED_CONFIG_KEYS = frozenset(
    {"timeoutseconds", "timeout_seconds", "apiversion", "api_version"}
)

# Operator-controlled (env, NOT flow-author) allowance for a non-local api_url.
_ALLOW_REMOTE_ENV = "ATOMICMEMORY_LANGFLOW_ALLOW_REMOTE"
_ALLOWED_HOSTS_ENV = "ATOMICMEMORY_LANGFLOW_ALLOWED_HOSTS"


def sdk_is_available() -> bool:
    try:
        import atomicmemory  # noqa: F401
    except Exception:  # pragma: no cover - import guard
        return False
    return True


def _require_sdk():
    try:
        import atomicmemory
    except ImportError as exc:  # pragma: no cover - exercised via monkeypatch
        raise RuntimeError(
            "The 'atomicmemory' SDK is required for AtomicMemory components. "
            "Install it with: pip install atomicmemory"
        ) from exc
    return atomicmemory


def _env_truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"} if value else False


def _remote_host_allowed(host: str) -> bool:
    if _env_truthy(os.environ.get(_ALLOW_REMOTE_ENV)):
        return True
    allowed = os.environ.get(_ALLOWED_HOSTS_ENV, "")
    return host in {h.strip().lower() for h in allowed.split(",") if h.strip()}


def validate_api_url(api_url: Any) -> str:
    url = (str(api_url).strip() if api_url else "") or DEFAULT_API_URL
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"api_url must be http or https, got: {url!r}")
    host = (parsed.hostname or "").lower()
    if host not in _LOCAL_HOSTS and not _remote_host_allowed(host):
        # Restrict non-local hosts unless the operator opts in via env. NOTE: this is
        # not full SSRF protection — loopback (localhost ports) is always allowed; see
        # the README security section for the shared/cloud caveat.
        raise ValueError(
            f"api_url host {host!r} is not local and not allowed. To use a remote "
            f"AtomicMemory Core, the operator must set {_ALLOW_REMOTE_ENV}=1 or list "
            f"the host in {_ALLOWED_HOSTS_ENV} (comma-separated)."
        )
    return url


def _normalize_key(key: Any) -> str:
    return str(key).strip().lower().replace("-", "_").replace(" ", "_")


def validate_provider(provider: Any) -> str:
    name = (str(provider).strip() if provider else "") or "atomicmemory"
    if name not in SUPPORTED_PROVIDERS:
        raise ValueError(
            f"Unsupported provider {name!r}. Phase 1 supports only: "
            f"{', '.join(sorted(SUPPORTED_PROVIDERS))}."
        )
    return name


def validate_provider_config(provider_config: Any) -> dict[str, Any]:
    """Allowlist-only: accept just known tuning keys; reject everything else
    (URLs, keys, and any secret-shaped key like accessToken/clientSecret)."""
    cfg = dict(provider_config or {})
    for key in cfg:
        if _normalize_key(key) not in _ALLOWED_CONFIG_KEYS:
            raise ValueError(
                f"provider_config key {key!r} is not allowed. Phase 1 accepts only "
                "tuning keys (timeoutSeconds, apiVersion); set the API URL/Key via the "
                "component's 'API URL' and 'API Key' (secret) fields, not provider_config."
            )
    return cfg


class AtomicMemoryBridge:
    """Thin, sync boundary over the AtomicMemory SDK MemoryClient.

    A client is constructed + initialized + closed per operation (cheap at
    canvas latencies; avoids connection leaks and cross-run state). Requests are
    plain dicts; the SDK coerces/validates them.
    """

    def __init__(
        self,
        *,
        provider: str = "atomicmemory",
        api_url: Any = None,
        api_key: Any = None,
        provider_config: Any = None,
        client_factory: Callable[[dict, str], Any] | None = None,
    ) -> None:
        self._provider = validate_provider(provider)
        self._api_url = validate_api_url(api_url)
        self._api_key = (str(api_key).strip() or None) if api_key else None
        self._provider_config = validate_provider_config(provider_config)
        self._client_factory = client_factory

    def _provider_settings(self) -> dict[str, Any]:
        # provider_config first, then the validated connection fields LAST so they
        # can never be overridden (defense in depth alongside validate_provider_config).
        settings: dict[str, Any] = {**self._provider_config, "apiUrl": self._api_url}
        if self._api_key:
            settings["apiKey"] = self._api_key
        return settings

    @contextmanager
    def _client(self) -> Iterator[Any]:
        if self._client_factory is not None:
            client = self._client_factory({self._provider: self._provider_settings()}, self._provider)
        else:
            am = _require_sdk()
            client = am.MemoryClient(
                providers={self._provider: self._provider_settings()},
                default_provider=self._provider,
            )
        try:
            client.initialize()
            yield client
        finally:
            client.close()

    def capabilities(self):
        with self._client() as client:
            return client.capabilities()

    def ingest_messages(self, *, scope: dict, messages: list[dict], metadata: dict | None = None):
        with self._client() as client:
            return client.ingest(
                {
                    "mode": "messages",
                    "scope": scope,
                    "messages": messages,
                    "provenance": {"source": "langflow"},
                    "metadata": metadata or {},
                }
            )

    def list_memories(self, *, scope: dict, limit: int):
        with self._client() as client:
            return client.list({"scope": scope, "limit": limit})

    def search(self, *, scope: dict, query: str, limit: int):
        with self._client() as client:
            return client.search({"scope": scope, "query": query, "limit": limit})

    def package(self, *, scope: dict, query: str, limit: int, token_budget: int | None = None):
        with self._client() as client:
            req: dict[str, Any] = {"scope": scope, "query": query, "limit": limit}
            if token_budget is not None:
                req["token_budget"] = token_budget
            return client.package(req)

    def delete_scope(self, *, scope: dict, page_size: int = 100) -> dict[str, int]:
        """Best-effort scope erasure: page list() then delete() each id.

        The SDK has no native scope-wipe; this is best-effort over SDK-visible
        memories. Ids are collected first (no mutate-while-paginating).
        """
        with self._client() as client:
            ids: list[str] = []
            cursor: str | None = None
            while True:
                req: dict[str, Any] = {"scope": scope, "limit": page_size}
                if cursor:
                    req["cursor"] = cursor
                page = client.list(req)
                ids.extend(m.id for m in page.memories)
                cursor = getattr(page, "cursor", None)
                if not cursor or not page.memories:
                    break
            deleted = failed = 0
            for mid in ids:
                try:
                    client.delete({"id": mid, "scope": scope})
                    deleted += 1
                except Exception:  # noqa: BLE001 - best-effort; count failures
                    failed += 1
            return {"deleted": deleted, "failed": failed, "found": len(ids)}
