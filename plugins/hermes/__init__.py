"""AtomicMemory native memory provider for Hermes Agent (v2).

Thin Python adapter over the AtomicMemory Python SDK. The provider owns Hermes
lifecycle compatibility (provider registration, hook dispatch, tool schemas,
worker supervision); all memory semantics flow through `AtomicMemoryClient`.

Default scope is `shared` — Hermes recalls memories from every AtomicMemory
tool the user has touched. Set `memory_scope=siloed` to restrict recall to
Hermes-ingested memories only.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Callable

from .breaker import CircuitBreaker
from .client import (
    AtomicMemoryClient,
    BridgeError,
    Message,
    Provenance,
)
from .config import (
    DEFAULT_USER_ID,
    SOURCE_SITE,
    ProviderConfig,
    get_config_schema,
    ingest_scope_dict,
    load_config,
    read_scope_kwargs,
    save_config,
)
from .python_sdk import (
    PythonSdkAtomicMemoryClient,
    PythonSdkConfig,
    sdk_is_available,
)
from .tools import (
    CONCLUDE_SCHEMA,
    CONTEXT_SCHEMA,
    SEARCH_SCHEMA,
    TOOL_HANDLERS,
    format_memory_bullets,
    profile_schema,
)
from .worker import IngestJob, IngestWorker


try:
    from agent.memory_provider import MemoryProvider  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — used only outside Hermes test runs.
    class MemoryProvider:  # type: ignore[no-redef]
        """Fallback base class so the provider can be unit-tested standalone."""


try:
    from tools.registry import tool_error  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — used only outside Hermes test runs.
    def tool_error(message: str) -> str:
        return json.dumps({"error": message})


logger = logging.getLogger(__name__)


class AtomicMemoryMemoryProvider(MemoryProvider):
    """Hermes-compatible AtomicMemory memory provider."""

    def __init__(
        self,
        *,
        client_factory: Callable[[ProviderConfig], AtomicMemoryClient] | None = None,
    ) -> None:
        self._client_factory = client_factory or _default_client_factory
        self._client: AtomicMemoryClient | None = None
        self._config: ProviderConfig = ProviderConfig()
        self._session_id: str = ""
        self._user_id: str = DEFAULT_USER_ID

        self._breaker = CircuitBreaker()
        self._worker: IngestWorker | None = None

        self._prefetch_lock = threading.Lock()
        self._prefetch_result: str = ""
        self._prefetch_generation: int = 0
        self._prefetch_thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # Hermes provider contract
    # ------------------------------------------------------------------

    @property
    def name(self) -> str:
        return "atomicmemory"

    def is_available(self) -> bool:
        if not os.environ.get("ATOMICMEMORY_API_URL"):
            return False
        return sdk_is_available()

    def get_config_schema(self) -> list[dict[str, Any]]:
        return get_config_schema()

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        save_config(values, hermes_home)

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        hermes_home = kwargs.get("hermes_home")
        self._config = load_config(hermes_home=hermes_home)
        self._user_id = (
            _clean_str(kwargs.get("user_id"))
            or self._config.scope_user
            or DEFAULT_USER_ID
        )
        self._session_id = session_id
        client = self._client_factory(self._config)
        client.initialize()
        self._client = client
        self._worker = IngestWorker(
            run_job=self._run_ingest_job,
            on_failure=self._on_ingest_failure,
        )
        self._worker.start()

    def system_prompt_block(self) -> str:
        action = (
            "Use atomicmemory_search for targeted recall, atomicmemory_context for broad context, "
            "and atomicmemory_conclude to store explicit durable facts."
            if self._tools_enabled()
            else "AtomicMemory recall is injected automatically; explicit AtomicMemory tools are disabled."
        )
        return (
            "# AtomicMemory\n"
            f"Active. User: {self._user_id}. Memory mode: {self._config.memory_mode}. "
            f"Scope: {self._config.memory_scope}.\n"
            f"{action}"
        )

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        del session_id
        if not self._context_enabled() or not self._config.prefetch_enabled:
            return
        if self._breaker.is_open() or not query:
            return
        with self._prefetch_lock:
            self._prefetch_generation += 1
            generation = self._prefetch_generation

        def _run() -> None:
            try:
                result = self._prefetch_text(query)
                if result:
                    with self._prefetch_lock:
                        if generation == self._prefetch_generation:
                            self._prefetch_result = result
                self._breaker.record_success()
            except Exception as exc:  # noqa: BLE001
                self._breaker.record_failure()
                logger.debug("AtomicMemory prefetch failed: %s", exc)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="atomicmemory-prefetch",
        )
        self._prefetch_thread.start()

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        del query, session_id
        if not self._context_enabled():
            return ""
        thread = self._prefetch_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=3.0)
        with self._prefetch_lock:
            result = self._prefetch_result
            self._prefetch_result = ""
        return f"## AtomicMemory\n{result}" if result else ""

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        if not self._context_enabled() or self._breaker.is_open() or self._worker is None:
            return
        self._worker.submit(
            IngestJob(
                user_content=user_content,
                assistant_content=assistant_content,
                session_id=session_id or self._session_id,
            ),
        )

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        del messages
        self.shutdown()

    def shutdown(self) -> None:
        if self._worker is not None:
            self._worker.shutdown()
            self._worker = None
        if self._client is not None:
            try:
                self._client.shutdown()
            except Exception as exc:  # noqa: BLE001
                logger.debug("AtomicMemory client shutdown failed: %s", exc)
            self._client = None

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        if not self._tools_enabled():
            return []
        return [
            profile_schema(self._config.memory_scope),
            SEARCH_SCHEMA,
            CONTEXT_SCHEMA,
            CONCLUDE_SCHEMA,
        ]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        del kwargs
        if not self._tools_enabled():
            return tool_error("AtomicMemory tools are disabled by memory_mode.")
        if self._breaker.is_open():
            return json.dumps(
                {
                    "error": (
                        "AtomicMemory client temporarily unavailable after repeated failures. "
                        "It will retry automatically."
                    ),
                },
            )
        handler = TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return tool_error(f"Unknown tool: {tool_name}")
        try:
            result = handler(self, args)
            self._breaker.record_success()
            return result
        except Exception as exc:  # noqa: BLE001
            self._breaker.record_failure()
            return tool_error(str(exc))

    # ------------------------------------------------------------------
    # Helpers shared with tools.py
    # ------------------------------------------------------------------

    def _context_enabled(self) -> bool:
        return self._config.memory_mode in {"hybrid", "context"}

    def _tools_enabled(self) -> bool:
        return self._config.memory_mode in {"hybrid", "tools"}

    def _require_client(self) -> AtomicMemoryClient:
        if self._client is None:
            raise BridgeError("AtomicMemory client not initialized", code="NOT_INITIALIZED")
        return self._client

    def _ingest_provenance(self, *, session_id: str) -> Provenance:
        return Provenance(
            source=SOURCE_SITE,
            source_url=f"hermes://session/{session_id or self._session_id or 'default'}",
        )

    def _read_kwargs(self, *, limit_override: int | None = None) -> dict[str, Any]:
        kwargs = read_scope_kwargs(memory_scope=self._config.memory_scope, user_id=self._user_id)
        kwargs["limit"] = limit_override if limit_override is not None else self._config.search_limit
        return kwargs

    # ------------------------------------------------------------------
    # Prefetch + ingest worker
    # ------------------------------------------------------------------

    def _prefetch_text(self, query: str) -> str:
        client = self._require_client()
        kwargs = read_scope_kwargs(memory_scope=self._config.memory_scope, user_id=self._user_id)
        if self._config.prefetch_method == "fast":
            page = client.search(
                query=query,
                scope=kwargs["scope"],
                limit=self._config.search_limit,
                source_site=kwargs.get("source_site"),
            )
            return format_memory_bullets(page)
        package = client.package(
            query=query,
            scope=kwargs["scope"],
            token_budget=self._config.token_budget,
            source_site=kwargs.get("source_site"),
        )
        if package.injection_text:
            return package.injection_text
        return format_memory_bullets(package)

    def _run_ingest_job(self, job: IngestJob) -> None:
        if self._client is None:
            return
        try:
            self._client.ingest_messages(
                messages=[
                    Message(role="user", content=job.user_content),
                    Message(role="assistant", content=job.assistant_content),
                ],
                scope=ingest_scope_dict(user_id=self._user_id),
                provenance=self._ingest_provenance(session_id=job.session_id),
                metadata={"kind": "turn"},
            )
            self._breaker.record_success()
        except Exception:
            self._breaker.record_failure()
            raise

    def _on_ingest_failure(self, exc: BaseException) -> None:
        logger.warning("AtomicMemory ingest failed: %s", exc)


def _default_client_factory(config: ProviderConfig) -> AtomicMemoryClient:
    return PythonSdkAtomicMemoryClient(
        config=PythonSdkConfig(
            provider=os.environ.get("ATOMICMEMORY_PROVIDER", "atomicmemory"),
            api_url=os.environ.get("ATOMICMEMORY_API_URL"),
            api_key=os.environ.get("ATOMICMEMORY_API_KEY"),
        )
    )


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def register(ctx: Any) -> None:
    ctx.register_memory_provider(AtomicMemoryMemoryProvider())
