"""Map Langflow inputs to an AtomicMemory SDK scope dict (lfx-free, SDK-free)."""

from __future__ import annotations

from typing import Any


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def build_scope(
    user_id: Any,
    *,
    session_id: Any = None,
    namespace: Any = None,
    agent_id: Any = None,
) -> dict[str, str]:
    """Build an SDK scope dict. ``user`` is required (Core enforces it).

    Langflow session -> ``thread``; namespace -> ``namespace``; agent -> ``agent``.
    Optional fields are omitted when blank.
    """
    user = _clean(user_id)
    if not user:
        raise ValueError("AtomicMemory requires a non-empty user_id.")
    scope: dict[str, str] = {"user": user}
    thread = _clean(session_id)
    if thread:
        scope["thread"] = thread
    ns = _clean(namespace)
    if ns:
        scope["namespace"] = ns
    agent = _clean(agent_id)
    if agent:
        scope["agent"] = agent
    return scope
