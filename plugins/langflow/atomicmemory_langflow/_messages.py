"""Convert between Langflow/LangChain senders and SDK roles, and map stored
memories to LangChain messages (lfx-free)."""

from __future__ import annotations

from typing import Any


def coerce_text(value: Any) -> str:
    """Extract plain text from an input that may be a Langflow/LangChain Message.

    A MessageTextInput fed from another component's Message output can arrive as
    a Message object, whose ``str()`` is its JSON serialization (``{"text": ...}``),
    not the text. Stringifying that as a search query or ingest content corrupts
    it. Prefer ``.text`` when present; otherwise fall back to ``str()``.
    """
    if value is None:
        return ""
    text = getattr(value, "text", None)
    if isinstance(text, str):
        return text
    return str(value)


# Langflow sender constants ("User"/"Machine"/"System"/"Tool") + LangChain
# message types ("human"/"ai"/"system"/"tool") -> SDK role.
_SENDER_TO_ROLE = {
    "user": "user",
    "human": "user",
    "assistant": "assistant",
    "ai": "assistant",
    "machine": "assistant",
    "system": "system",
    "tool": "tool",
}


def sender_to_role(sender: Any) -> str:
    """Total map to an SDK role (`user|assistant|system|tool`); unknown -> `user`."""
    if sender is None:
        return "user"
    return _SENDER_TO_ROLE.get(str(sender).strip().lower(), "user")


def memory_to_lc_message(memory: Any):
    """Map a stored Memory to a LangChain message.

    Role is NOT generally preserved: the AtomicMemory provider flattens
    messages-mode ingest into a transcript and extracts semantic memories, so
    most recalled memories have no ``role`` metadata and come back as a
    ``[memory] …`` HumanMessage. The ``role == "assistant"`` check below is
    best-effort for the rare case a provider surfaces role metadata.

    SECURITY: retrieved memory is user-influenced; never return a SystemMessage
    (which would grant system authority — a prompt-injection vector). Everything
    that isn't an explicit assistant memory is a HumanMessage tagged ``[memory]``
    so downstream prompts can see it is recalled context.
    """
    from langchain_core.messages import AIMessage, HumanMessage

    content = getattr(memory, "content", "") or ""
    role = None
    meta = getattr(memory, "metadata", None)
    if isinstance(meta, dict):
        role = meta.get("role")
    if role == "assistant":
        return AIMessage(content=content)
    return HumanMessage(content=f"[memory] {content}")
