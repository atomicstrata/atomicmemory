"""AtomicMemoryClient protocol.

Narrow seam between the Hermes Python provider and the AtomicMemory Python SDK.
The provider depends only on this interface so lifecycle code, tool handlers,
scope policy, and tests are isolated from SDK-specific response shapes.

The shapes here intentionally drop SDK fields the Hermes integration does
not consume (importance, tier assignments, observability blocks). Add them
when a call site needs them, not before.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


Scope = dict[str, Any]
"""Scope dict matching the V3 MemoryClient shape: {user, agent?, namespace?, thread?}.

Hermes uses user-only scope. Workspace scope is left available for future
provider modes but is not exercised in v2.
"""


@dataclass(frozen=True)
class Message:
    """One turn message used by ingest_messages."""

    role: str
    content: str


@dataclass(frozen=True)
class Provenance:
    """Ingest provenance. source is required by Hermes; everything else optional."""

    source: str
    source_url: str | None = None
    source_id: str | None = None
    extractor: str | None = None


@dataclass(frozen=True)
class MemoryItem:
    """Minimal memory record consumed by Hermes tools (search/list/profile)."""

    id: str | None
    content: str
    score: float | None = None
    source_site: str | None = None
    created_at: str | None = None


@dataclass(frozen=True)
class SearchPage:
    memories: list[MemoryItem] = field(default_factory=list)
    count: int = 0


@dataclass(frozen=True)
class ContextPackage:
    injection_text: str = ""
    memories: list[MemoryItem] = field(default_factory=list)
    count: int = 0
    estimated_context_tokens: int = 0
    citations: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ListPage:
    memories: list[MemoryItem] = field(default_factory=list)
    count: int = 0


@dataclass(frozen=True)
class IngestResult:
    created: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)


class BridgeError(RuntimeError):
    """Bridge call returned a typed error."""

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class BridgeCrashedError(BridgeError):
    """Client transport exited unexpectedly mid-call."""

    def __init__(self, message: str = "AtomicMemory client transport exited") -> None:
        super().__init__(message, code="BRIDGE_CRASHED")


class ProviderUnsupportedError(BridgeError):
    """Client returned PROVIDER_UNSUPPORTED — the active provider lacks a feature.

    Today this happens when source_site is requested with a non-AtomicMemory
    provider. The client fails loudly rather than silently dropping the filter.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message, code="PROVIDER_UNSUPPORTED")


class AtomicMemoryClient(Protocol):
    """Narrow client surface used by the Hermes provider.

    The production Python SDK implementation lives in python_sdk.py.
    """

    def initialize(self) -> None: ...

    def shutdown(self) -> None: ...

    def search(
        self,
        *,
        query: str,
        scope: Scope,
        limit: int,
        source_site: str | None = None,
    ) -> SearchPage: ...

    def package(
        self,
        *,
        query: str,
        scope: Scope,
        token_budget: int,
        source_site: str | None = None,
    ) -> ContextPackage: ...

    def list_recent(
        self,
        *,
        scope: Scope,
        limit: int,
        source_site: str | None = None,
    ) -> ListPage: ...

    def ingest_messages(
        self,
        *,
        messages: list[Message],
        scope: Scope,
        provenance: Provenance,
        metadata: dict[str, Any] | None = None,
    ) -> IngestResult: ...

    def ingest_verbatim(
        self,
        *,
        content: str,
        scope: Scope,
        provenance: Provenance,
        metadata: dict[str, Any] | None = None,
    ) -> IngestResult: ...
