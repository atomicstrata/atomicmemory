"""AtomicMemory custom components for Langflow.

Importing this package does NOT import Langflow (`lfx`). Component classes are
resolved lazily via ``__getattr__`` so the lfx-free helper modules
(``_scope``/``_messages``/``_sdk``/``_chat_history``) stay unit-testable without
the Langflow host installed.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

__version__ = "0.1.0"

_EXPORTS = {
    "AtomicMemoryChatMemoryComponent": "chat_memory",
    "AtomicMemorySearchContextComponent": "search_context",
    "AtomicMemoryStoreMessageComponent": "store_message",
    "AtomicMemoryDeleteComponent": "delete",
}

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(import_module(f".{module}", __name__), name)
