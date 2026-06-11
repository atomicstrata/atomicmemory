"""AtomicMemory Store Message — explicitly persist one message into memory."""

from __future__ import annotations

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import DropdownInput, MessageTextInput
from lfx.schema.message import Message
from lfx.template.field.base import Output

from ._component_base import AtomicMemoryComponentMixin
from ._inputs import connection_inputs, scope_inputs
from ._messages import coerce_text, sender_to_role

MAX_CONTENT_CHARS = 100_000  # Core rejects conversations beyond this.


class AtomicMemoryStoreMessageComponent(AtomicMemoryComponentMixin, Component):
    display_name = "Store Message (AtomicMemory)"
    description = "Store a message/turn into AtomicMemory (explicit, visible write)."
    name = "AtomicMemoryStoreMessage"
    icon = "save"

    inputs = [
        MessageTextInput(name="message", display_name="Message", required=True),
        DropdownInput(
            name="sender",
            display_name="Sender",
            options=["User", "Machine", "System", "Tool"],
            value="User",
        ),
        *connection_inputs(),
        *scope_inputs(),
    ]

    outputs = [Output(name="stored_message", display_name="Stored Message", method="store_message")]

    def store_message(self) -> Message:
        text = coerce_text(self.message).strip()
        if not text:
            # Fail closed even on API/tweak paths (the UI marks the field required).
            raise ValueError("Store Message requires non-empty message content.")
        if len(text) > MAX_CONTENT_CHARS:
            raise ValueError(
                f"message is {len(text)} chars; AtomicMemory Core limit is {MAX_CONTENT_CHARS}."
            )
        scope = self._build_scope()
        bridge = self._build_bridge()
        role = sender_to_role(self.sender)
        result = bridge.ingest_messages(
            scope=scope,
            messages=[{"role": role, "content": text}],
            metadata={"kind": "turn"},
        )
        outcome = {
            "created": len(getattr(result, "created", []) or []),
            "updated": len(getattr(result, "updated", []) or []),
            "unchanged": len(getattr(result, "unchanged", []) or []),
        }
        self.status = (
            f"stored · +{outcome['created']} ~{outcome['updated']} ={outcome['unchanged']}"
        )
        return Message(
            text=text,
            sender=self.sender,
            sender_name="AtomicMemory",
            session_metadata={"atomicmemory": outcome},
        )
