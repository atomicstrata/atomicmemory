"""FakeAtomicMemoryClient — deterministic recorder used by provider tests.

Captures every call's kwargs and returns canned responses set per test.
Used by test_provider.py so provider tests do not need a live SDK client.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from plugins.hermes.client import (
    AtomicMemoryClient,
    ContextPackage,
    IngestResult,
    ListPage,
    Message,
    MemoryItem,
    Provenance,
    Scope,
    SearchPage,
)


@dataclass
class RecordedCall:
    method: str
    kwargs: dict[str, Any]


@dataclass
class FakeAtomicMemoryClient:
    """In-memory AtomicMemoryClient implementation.

    Set the *_response attributes to control return values. Each call is
    appended to `calls` for assertion in tests.
    """

    initialized: int = 0
    shutdown_called: int = 0
    calls: list[RecordedCall] = field(default_factory=list)

    search_response: SearchPage = field(default_factory=SearchPage)
    package_response: ContextPackage = field(default_factory=ContextPackage)
    list_response: ListPage = field(default_factory=ListPage)
    ingest_response: IngestResult = field(default_factory=IngestResult)

    raise_on: str | None = None
    """If set, the named method raises BridgeError on next call."""

    def initialize(self) -> None:
        self.initialized += 1

    def shutdown(self) -> None:
        self.shutdown_called += 1

    def search(
        self,
        *,
        query: str,
        scope: Scope,
        limit: int,
        source_site: str | None = None,
    ) -> SearchPage:
        self._record("search", query=query, scope=scope, limit=limit, source_site=source_site)
        self._maybe_raise("search")
        return self.search_response

    def package(
        self,
        *,
        query: str,
        scope: Scope,
        token_budget: int,
        source_site: str | None = None,
    ) -> ContextPackage:
        self._record(
            "package",
            query=query,
            scope=scope,
            token_budget=token_budget,
            source_site=source_site,
        )
        self._maybe_raise("package")
        return self.package_response

    def list_recent(
        self,
        *,
        scope: Scope,
        limit: int,
        source_site: str | None = None,
    ) -> ListPage:
        self._record("list_recent", scope=scope, limit=limit, source_site=source_site)
        self._maybe_raise("list_recent")
        return self.list_response

    def ingest_messages(
        self,
        *,
        messages: list[Message],
        scope: Scope,
        provenance: Provenance,
        metadata: dict[str, Any] | None = None,
    ) -> IngestResult:
        self._record(
            "ingest_messages",
            messages=messages,
            scope=scope,
            provenance=provenance,
            metadata=metadata,
        )
        self._maybe_raise("ingest_messages")
        return self.ingest_response

    def ingest_verbatim(
        self,
        *,
        content: str,
        scope: Scope,
        provenance: Provenance,
        metadata: dict[str, Any] | None = None,
    ) -> IngestResult:
        self._record(
            "ingest_verbatim",
            content=content,
            scope=scope,
            provenance=provenance,
            metadata=metadata,
        )
        self._maybe_raise("ingest_verbatim")
        return self.ingest_response

    def _record(self, method: str, **kwargs: Any) -> None:
        self.calls.append(RecordedCall(method=method, kwargs=kwargs))

    def _maybe_raise(self, method: str) -> None:
        if self.raise_on == method:
            self.raise_on = None
            from plugins.hermes.client import BridgeError

            raise BridgeError(f"injected fake error from {method}")

    def calls_to(self, method: str) -> list[RecordedCall]:
        return [c for c in self.calls if c.method == method]


# Convenience constructor used by multiple tests.
def make_memory(content: str, *, mid: str = "m1", score: float = 0.9) -> MemoryItem:
    return MemoryItem(id=mid, content=content, score=score, source_site="hermes")


# Type-check that FakeAtomicMemoryClient satisfies the protocol at import.
_check: AtomicMemoryClient = FakeAtomicMemoryClient()
