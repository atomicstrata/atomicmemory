"""AtomicMemory Chat Memory — read-only Langflow Message History backend."""

from __future__ import annotations

from lfx.base.memory.model import LCChatMemoryComponent
from lfx.field_typing.constants import Memory
from lfx.inputs.inputs import BoolInput, IntInput

from ._chat_history import AtomicMemoryChatMessageHistory
from ._component_base import AtomicMemoryComponentMixin
from ._inputs import connection_inputs, scope_inputs

MAX_HISTORY_LIMIT = 100


class AtomicMemoryChatMemoryComponent(AtomicMemoryComponentMixin, LCChatMemoryComponent):
    display_name = "Chat Memory (AtomicMemory)"
    description = (
        "Read-only chat history backed by AtomicMemory (semantic memory for the "
        "user/session). Persist memory with the AtomicMemory Store Message component."
    )
    name = "AtomicMemoryChatMemory"
    icon = "messages-square"

    inputs = [
        *connection_inputs(),
        *scope_inputs(),
        IntInput(
            name="limit",
            display_name="Max memories",
            value=10,
            info=f"Maximum memories to surface as history (capped at {MAX_HISTORY_LIMIT}).",
        ),
        BoolInput(
            name="fail_open",
            display_name="Fail open on error",
            value=False,
            advanced=True,
            info="If the memory backend is unreachable: when false (default), raise a "
            "clear error; when true, return empty history instead.",
        ),
    ]

    def build_message_history(self) -> Memory:
        scope = self._build_scope()
        bridge = self._build_bridge()
        try:
            raw = int(self.limit)
        except (TypeError, ValueError):
            raw = 10
        limit = max(1, min(raw, MAX_HISTORY_LIMIT))
        self.status = f"AtomicMemory history · user={scope['user']} · limit={limit}"
        return AtomicMemoryChatMessageHistory(
            bridge=bridge, scope=scope, limit=limit, fail_open=bool(self.fail_open),
        )
