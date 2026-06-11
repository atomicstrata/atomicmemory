"""Read-only LangChain chat history backed by AtomicMemory (lfx-free)."""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.messages import BaseMessage

from ._messages import memory_to_lc_message

logger = logging.getLogger(__name__)


class AtomicMemoryChatMessageHistory(BaseChatMessageHistory):
    """Surfaces a scope's memories as chat history. Writes are no-ops here —
    use the Store Message component. LangChain provides the async surface
    (aget_messages/aadd_messages) by delegating to these sync methods.
    """

    def __init__(self, *, bridge: Any, scope: dict, limit: int, fail_open: bool = False) -> None:
        self._bridge = bridge
        self._scope = scope
        self._limit = limit
        self._fail_open = fail_open
        self._warned = False

    @property
    def messages(self) -> list[BaseMessage]:
        try:
            page = self._bridge.list_memories(scope=self._scope, limit=self._limit)
        except Exception as exc:
            # Fail closed by default: surface "memory unavailable" rather than
            # silently pretending the user has no memory. Opt into soft failure
            # (empty history) with fail_open=True.
            if self._fail_open:
                logger.warning(
                    "AtomicMemory history read failed; returning empty history (fail_open): %s", exc
                )
                return []
            raise RuntimeError(f"AtomicMemory history read failed: {exc}") from exc
        memories = list(getattr(page, "memories", []))
        memories.reverse()  # newest-first -> chronological
        return [memory_to_lc_message(m) for m in memories]

    def add_messages(self, messages: list[BaseMessage]) -> None:
        if not self._warned:
            logger.warning(
                "AtomicMemory Chat Memory is read-only; writes here are ignored. "
                "Use the 'AtomicMemory Store Message' component to persist memory."
            )
            self._warned = True

    def add_message(self, message: BaseMessage) -> None:
        self.add_messages([message])

    def clear(self) -> None:
        # Read-only; erasure is via the AtomicMemory Delete component.
        return None
