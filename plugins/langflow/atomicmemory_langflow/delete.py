"""AtomicMemory Delete Memories in Scope — best-effort erasure (right-to-erasure).

Deletes the SDK-visible memories in a scope (paged list -> delete each). Not a
native atomic Core scope-wipe. Confirmation-gated.
"""

from __future__ import annotations

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import BoolInput
from lfx.schema.message import Message
from lfx.template.field.base import Output

from ._component_base import AtomicMemoryComponentMixin
from ._inputs import connection_inputs, scope_inputs


class AtomicMemoryDeleteComponent(AtomicMemoryComponentMixin, Component):
    display_name = "Delete Memories in Scope (AtomicMemory)"
    description = (
        "Delete the SDK-visible memories in a scope (best-effort, not an atomic "
        "Core wipe). Requires explicit confirmation."
    )
    name = "AtomicMemoryDelete"
    icon = "trash"

    inputs = [
        *connection_inputs(),
        *scope_inputs(),
        BoolInput(
            name="confirm",
            display_name="Confirm",
            value=False,
            info="Must be true to delete. Guards against accidental erasure.",
        ),
    ]

    outputs = [Output(name="result", display_name="Result", method="delete")]

    def delete(self) -> Message:
        scope = self._build_scope()
        if not self.confirm:
            text = "Delete skipped: set 'Confirm' to true to erase memories in this scope."
            self.status = "skipped (confirm=false)"
            return Message(text=text, sender="Machine", sender_name="AtomicMemory")
        bridge = self._build_bridge()
        summary = bridge.delete_scope(scope=scope)
        text = (
            f"Deleted {summary['deleted']} of {summary['found']} memories "
            f"(failed {summary['failed']}) for scope {scope}."
        )
        self.status = text
        return Message(
            text=text, sender="Machine", sender_name="AtomicMemory",
            session_metadata={"atomicmemory": summary},
        )
