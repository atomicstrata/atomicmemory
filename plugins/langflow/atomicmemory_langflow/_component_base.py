"""Mixin shared by the AtomicMemory components (lfx-free; only reads attrs).

Inputs are named ``memory_user_id``/``memory_session_id`` (NOT ``user_id``) to
avoid colliding with Langflow's base ``Component.user_id`` property, which holds
the authenticated run user we fall back to.
"""

from __future__ import annotations

from typing import Any

from ._scope import build_scope
from ._sdk import AtomicMemoryBridge


class AtomicMemoryComponentMixin:
    def _resolve_user_id(self) -> str:
        explicit = (getattr(self, "memory_user_id", "") or "")
        explicit = str(explicit).strip()
        if explicit:
            return explicit
        ctx = getattr(self, "user_id", None)  # base Component.user_id (run context)
        return str(ctx).strip() if ctx else ""

    def _resolve_session_id(self) -> str | None:
        explicit = (getattr(self, "memory_session_id", "") or "")
        explicit = str(explicit).strip()
        if explicit:
            return explicit
        graph = getattr(self, "graph", None)
        sid = getattr(graph, "session_id", None) if graph is not None else None
        return str(sid).strip() if sid else None

    def _build_scope(self, *, include_session: bool = True) -> dict:
        # namespace is intentionally not plumbed in Phase 1 (provider honors it
        # only on search/package, not ingest/list/delete). See _inputs.scope_inputs.
        # include_session=False yields a user-only scope for cross-session recall:
        # Core hard-filters search/list by session, so retrieval meant to span
        # sessions must omit the thread.
        return build_scope(
            self._resolve_user_id(),
            session_id=self._resolve_session_id() if include_session else None,
        )

    def _build_bridge(self) -> AtomicMemoryBridge:
        return AtomicMemoryBridge(
            provider=getattr(self, "provider", "atomicmemory"),
            api_url=getattr(self, "api_url", None),
            api_key=getattr(self, "api_key", None),
            provider_config=dict(getattr(self, "provider_config", {}) or {}),
        )
