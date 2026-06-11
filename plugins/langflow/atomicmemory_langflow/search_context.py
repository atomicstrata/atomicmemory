"""AtomicMemory Search Context — query-driven, prompt-ready memory context."""

from __future__ import annotations

from typing import Any

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import BoolInput, IntInput, MessageTextInput
from lfx.schema.message import Message
from lfx.template.field.base import Output

from ._component_base import AtomicMemoryComponentMixin
from ._inputs import connection_inputs, scope_inputs
from ._messages import coerce_text

DEFAULT_SEARCH_LIMIT = 5
MAX_SEARCH_LIMIT = 100


def _clamp_limit(value: Any) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return DEFAULT_SEARCH_LIMIT
    return max(1, min(limit, MAX_SEARCH_LIMIT))


def _format_results(page: Any) -> str:
    lines = []
    for result in getattr(page, "results", []) or []:
        memory = getattr(result, "memory", None)
        content = getattr(memory, "content", None) or getattr(result, "content", "")
        if content:
            lines.append(f"- {content}")
    return "\n".join(lines) if lines else "(no relevant memories found)"


class AtomicMemorySearchContextComponent(AtomicMemoryComponentMixin, Component):
    display_name = "Search Context (AtomicMemory)"
    description = "Retrieve relevant long-term memory for a query as prompt-ready context."
    name = "AtomicMemorySearchContext"
    icon = "search"

    inputs = [
        MessageTextInput(name="query", display_name="Query", required=True),
        *connection_inputs(),
        *scope_inputs(),
        IntInput(
            name="limit",
            display_name="Limit",
            value=DEFAULT_SEARCH_LIMIT,
            info=f"Max memories to retrieve (clamped to 1..{MAX_SEARCH_LIMIT}).",
        ),
        BoolInput(
            name="use_packaged_context",
            display_name="Use packaged context",
            value=True,
            info="Use the provider's packaged context. Requires provider support; "
            "turn off for search-only mode.",
        ),
        BoolInput(
            name="scope_to_session",
            display_name="Scope to session",
            value=False,
            advanced=True,
            info="When off (default), recall spans the user's whole memory across "
            "sessions — the point of long-term memory. When on, restrict retrieval to "
            "the current session/thread (Core hard-filters by session).",
        ),
    ]

    outputs = [Output(name="context", display_name="Context", method="build_context")]

    def build_context(self) -> Message:
        query = coerce_text(self.query).strip()
        if not query:
            raise ValueError("Search Context requires a non-empty query.")
        # Long-term recall is user-scoped by default (cross-session); opt into
        # session-only retrieval with scope_to_session.
        scope = self._build_scope(include_session=bool(self.scope_to_session))
        bridge = self._build_bridge()
        limit = _clamp_limit(self.limit)

        if self.use_packaged_context:
            caps = bridge.capabilities()
            if not getattr(getattr(caps, "extensions", None), "package", False):
                raise ValueError(
                    "Provider does not support packaged context "
                    "(capabilities().extensions.package is false). "
                    "Set 'Use packaged context' to false for search-only mode."
                )
            package = bridge.package(scope=scope, query=query, limit=limit)
            text = package.text
        else:
            page = bridge.search(scope=scope, query=query, limit=limit)
            text = _format_results(page)

        self.status = f"AtomicMemory context · {len(text)} chars"
        # sender is required for Langflow message persistence (MessageResponse.from_message).
        return Message(text=text, sender="Machine", sender_name="AtomicMemory Search Context")
