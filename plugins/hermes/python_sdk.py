"""Python SDK client adapter for the Hermes AtomicMemory provider.

This module is the only production implementation of the Hermes
``AtomicMemoryClient`` protocol. It imports the published ``atomicmemory``
Python SDK, then routes shared reads through the generic SDK surface and
siloed reads through the AtomicMemory namespace where ``source_site`` is
supported.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import (
    AtomicMemoryClient,
    BridgeError,
    ContextPackage,
    IngestResult,
    ListPage,
    MemoryItem,
    Message,
    ProviderUnsupportedError,
    Provenance,
    Scope,
    SearchPage,
)


@dataclass(frozen=True)
class PythonSdkConfig:
    """Runtime config needed to construct the Python SDK MemoryClient."""

    provider: str = "atomicmemory"
    api_url: str | None = None
    api_key: str | None = None


@dataclass(frozen=True)
class PythonSdkTypes:
    """SDK classes used by this adapter.

    Tests inject fakes here so adapter behavior stays deterministic without a
    live core server or an installed SDK package.
    """

    MemoryClient: Any
    UserScope: Any
    AtomicMemorySearchRequest: Any
    AtomicMemoryListOptions: Any


def sdk_is_available() -> bool:
    """Return whether the published AtomicMemory Python SDK can be imported."""
    try:
        _load_sdk_types()
    except ImportError:
        return False
    return True


class PythonSdkAtomicMemoryClient:
    """AtomicMemoryClient implementation backed by the ``atomicmemory`` SDK."""

    def __init__(
        self,
        *,
        config: PythonSdkConfig,
        sdk_types: PythonSdkTypes | None = None,
    ) -> None:
        self._config = config
        self._types = sdk_types
        self._client: Any | None = None

    def initialize(self) -> None:
        if self._client is not None:
            return
        if not self._config.api_url:
            raise BridgeError("ATOMICMEMORY_API_URL is required", code="CONFIG_REQUIRED")
        types = self._types or _load_sdk_types()
        providers = {self._config.provider: _provider_config(self._config)}
        self._client = types.MemoryClient(providers=providers, default_provider=self._config.provider)
        self._client.initialize()
        self._types = types

    def shutdown(self) -> None:
        client = self._client
        self._client = None
        if client is not None:
            client.close()

    def search(
        self,
        *,
        query: str,
        scope: Scope,
        limit: int,
        source_site: str | None = None,
    ) -> SearchPage:
        if source_site:
            page = self._require_atomic().search(
                self._types.AtomicMemorySearchRequest(query=query, limit=limit, source_site=source_site),
                self._user_scope(scope),
            )
            return _search_page(page)
        page = self._require_client().search({"query": query, "scope": scope, "limit": limit})
        return _search_page(page)

    def package(
        self,
        *,
        query: str,
        scope: Scope,
        token_budget: int,
        source_site: str | None = None,
    ) -> ContextPackage:
        if source_site:
            page = self._require_atomic().search(
                self._types.AtomicMemorySearchRequest(
                    query=query,
                    retrieval_mode="tiered",
                    token_budget=token_budget,
                    source_site=source_site,
                    skip_repair=True,
                ),
                self._user_scope(scope),
            )
            return _atomic_context_package(page)
        package = self._require_client().package(
            {"query": query, "scope": scope, "token_budget": token_budget, "format": "tiered"}
        )
        return _generic_context_package(package)

    def list_recent(
        self,
        *,
        scope: Scope,
        limit: int,
        source_site: str | None = None,
    ) -> ListPage:
        if source_site:
            page = self._require_atomic().list(
                self._user_scope(scope),
                self._types.AtomicMemoryListOptions(limit=limit, source_site=source_site),
            )
            return _list_page(page)
        page = self._require_client().list({"scope": scope, "limit": limit})
        return _list_page(page)

    def ingest_messages(
        self,
        *,
        messages: list[Message],
        scope: Scope,
        provenance: Provenance,
        metadata: dict[str, Any] | None = None,
    ) -> IngestResult:
        raw = self._require_client().ingest(
            {
                "mode": "messages",
                "messages": [_message_dict(message) for message in messages],
                "scope": scope,
                "provenance": _provenance_dict(provenance),
                "metadata": metadata,
            }
        )
        return _ingest_result(raw)

    def ingest_verbatim(
        self,
        *,
        content: str,
        scope: Scope,
        provenance: Provenance,
        metadata: dict[str, Any] | None = None,
    ) -> IngestResult:
        raw = self._require_client().ingest(
            {
                "mode": "verbatim",
                "content": content,
                "scope": scope,
                "provenance": _provenance_dict(provenance),
                "metadata": metadata,
            }
        )
        return _ingest_result(raw)

    def _require_client(self) -> Any:
        if self._client is None:
            raise BridgeError("AtomicMemory Python SDK client is not initialized", code="NOT_INITIALIZED")
        return self._client

    def _require_atomic(self) -> Any:
        handle = self._require_client().atomicmemory
        if handle is None:
            raise ProviderUnsupportedError(
                "source_site requires the AtomicMemory provider; the active client has no atomicmemory namespace"
            )
        return handle

    def _user_scope(self, scope: Scope) -> Any:
        user = scope.get("user")
        if not user:
            raise BridgeError("scope.user is required for source_site routing", code="INVALID_SCOPE")
        return self._types.UserScope(user_id=user)


def _load_sdk_types() -> PythonSdkTypes:
    plugin_roots = _plugin_roots()
    removed_path_entries = _remove_plugin_import_roots(plugin_roots)
    try:
        saved_modules = _stash_plugin_atomicmemory_modules(plugin_roots)
        try:
            from atomicmemory import MemoryClient  # type: ignore[import-not-found]
            from atomicmemory.providers.atomicmemory.handle import (  # type: ignore[import-not-found]
                AtomicMemoryListOptions,
                AtomicMemorySearchRequest,
                UserScope,
            )
        finally:
            _restore_modules(saved_modules)
    finally:
        _restore_path_entries(removed_path_entries)

    return PythonSdkTypes(
        MemoryClient=MemoryClient,
        UserScope=UserScope,
        AtomicMemorySearchRequest=AtomicMemorySearchRequest,
        AtomicMemoryListOptions=AtomicMemoryListOptions,
    )


def _stash_plugin_atomicmemory_modules(plugin_roots: set[Path]) -> dict[str, Any]:
    saved: dict[str, Any] = {}
    for name, module in list(sys.modules.items()):
        if not _is_atomicmemory_module(name):
            continue
        if _should_stash_atomicmemory_module(name, module, plugin_roots):
            saved[name] = sys.modules.pop(name)
    return saved


def _restore_modules(saved_modules: dict[str, Any]) -> None:
    for name, module in saved_modules.items():
        sys.modules[name] = module


def _is_atomicmemory_module(name: str) -> bool:
    return name == "atomicmemory" or name.startswith("atomicmemory.")


def _plugin_roots() -> set[Path]:
    return {Path(__file__).resolve().parent}


def _remove_plugin_import_roots(plugin_roots: set[Path]) -> list[tuple[int, str]]:
    removed: list[tuple[int, str]] = []
    for index, path_entry in reversed(list(enumerate(sys.path))):
        if _path_entry_points_to_plugin(path_entry, plugin_roots):
            removed.append((index, sys.path.pop(index)))
    return list(reversed(removed))


def _restore_path_entries(removed_entries: list[tuple[int, str]]) -> None:
    for index, path_entry in removed_entries:
        sys.path.insert(min(index, len(sys.path)), path_entry)


def _path_entry_points_to_plugin(path_entry: str, plugin_roots: set[Path]) -> bool:
    raw_path = Path(path_entry or ".").expanduser()
    try:
        candidate = (raw_path / "atomicmemory").resolve()
    except OSError:
        return False
    return any(candidate == root for root in plugin_roots)


def _should_stash_atomicmemory_module(name: str, module: Any, plugin_roots: set[Path]) -> bool:
    if any(_module_is_under(module, root) for root in plugin_roots):
        return True
    return name == "atomicmemory" and not hasattr(module, "MemoryClient")


def _module_is_under(module: Any, root: Path) -> bool:
    file_name = getattr(module, "__file__", None)
    if not file_name:
        return False
    try:
        return Path(file_name).resolve().is_relative_to(root)
    except OSError:
        return False


def _provider_config(config: PythonSdkConfig) -> dict[str, str]:
    provider_config = {"api_url": config.api_url or ""}
    if config.api_key:
        provider_config["api_key"] = config.api_key
    return provider_config


def _message_dict(message: Message) -> dict[str, str]:
    return {"role": message.role, "content": message.content}


def _provenance_dict(provenance: Provenance) -> dict[str, str | None]:
    return {
        "source": provenance.source,
        "source_url": provenance.source_url,
        "source_id": provenance.source_id,
        "extractor": provenance.extractor,
    }


def _search_page(page: Any) -> SearchPage:
    hits = [_memory_from_hit(hit) for hit in _get(page, "results", [])]
    return SearchPage(memories=hits, count=int(_get(page, "count", len(hits)) or len(hits)))


def _list_page(page: Any) -> ListPage:
    memories = [_memory_item(memory) for memory in _get(page, "memories", [])]
    return ListPage(memories=memories, count=int(_get(page, "count", len(memories)) or len(memories)))


def _generic_context_package(package: Any) -> ContextPackage:
    hits = [_memory_from_hit(hit) for hit in _get(package, "results", [])]
    return ContextPackage(
        injection_text=str(_get(package, "text", "") or ""),
        memories=hits,
        count=len(hits),
        estimated_context_tokens=int(_get(package, "tokens", 0) or 0),
    )


def _atomic_context_package(page: Any) -> ContextPackage:
    hits = [_memory_from_hit(hit) for hit in _get(page, "results", [])]
    return ContextPackage(
        injection_text=str(_get(page, "injection_text", "") or ""),
        memories=hits,
        count=int(_get(page, "count", len(hits)) or len(hits)),
        estimated_context_tokens=int(_get(page, "estimated_context_tokens", 0) or 0),
        citations=list(_get(page, "citations", []) or []),
    )


def _memory_from_hit(hit: Any) -> MemoryItem:
    return _memory_item(_get(hit, "memory"), _get(hit, "score"))


def _memory_item(memory: Any, score: float | None = None) -> MemoryItem:
    provenance = _get(memory, "provenance")
    source_site = _get(memory, "source_site") or _get(provenance, "source")
    created_at = _get(memory, "created_at")
    return MemoryItem(
        id=_optional_str(_get(memory, "id")),
        content=str(_get(memory, "content", "") or ""),
        score=score,
        source_site=_optional_str(source_site),
        created_at=created_at.isoformat() if hasattr(created_at, "isoformat") else _optional_str(created_at),
    )


def _ingest_result(raw: Any) -> IngestResult:
    return IngestResult(
        created=list(_get(raw, "created", []) or _get(raw, "stored_memory_ids", []) or []),
        updated=list(_get(raw, "updated", []) or _get(raw, "updated_memory_ids", []) or []),
        unchanged=list(_get(raw, "unchanged", []) or []),
    )


def _get(value: Any, key: str, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _optional_str(value: Any) -> str | None:
    return str(value) if value is not None else None


_check: AtomicMemoryClient = PythonSdkAtomicMemoryClient(config=PythonSdkConfig())
