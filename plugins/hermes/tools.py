"""Tool schemas + handler dispatch for the Hermes memory provider.

Lives outside `__init__.py` so the provider class stays under the workspace
LOC ceiling. The handlers depend only on the provider's public-ish helpers
(`_require_client`, `_user_id`, `_session_id`, `_config`, `_read_kwargs`,
`_ingest_provenance`).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Callable

from .config import ingest_scope_dict, read_scope_kwargs


if TYPE_CHECKING:
    from . import AtomicMemoryMemoryProvider


try:
    from tools.registry import tool_error  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — used only outside Hermes test runs.
    def tool_error(message: str) -> str:
        return json.dumps({"error": message})


SEARCH_SCHEMA = {
    "name": "atomicmemory_search",
    "description": "Search AtomicMemory by meaning for prior user preferences, project context, decisions, and facts.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "top_k": {
                "type": "integer",
                "description": "Maximum results to return. Defaults to provider config, max 50.",
            },
        },
        "required": ["query"],
    },
}

CONTEXT_SCHEMA = {
    "name": "atomicmemory_context",
    "description": "Build an injection-ready AtomicMemory context package for a broad query.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The topic to assemble context for."},
            "token_budget": {
                "type": "integer",
                "description": "Approximate context budget. Defaults to provider config.",
            },
        },
        "required": ["query"],
    },
}

CONCLUDE_SCHEMA = {
    "name": "atomicmemory_conclude",
    "description": "Store one explicit durable fact, preference, correction, or decision in AtomicMemory.",
    "parameters": {
        "type": "object",
        "properties": {
            "conclusion": {"type": "string", "description": "The fact to store verbatim."},
        },
        "required": ["conclusion"],
    },
}


def profile_schema(memory_scope: str) -> dict[str, Any]:
    description = (
        "List recent records for the current Hermes user from any AtomicMemory tool."
        if memory_scope == "shared"
        else "List recent Hermes-source AtomicMemory records for the current user."
    )
    return {
        "name": "atomicmemory_profile",
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Maximum records to return. Defaults to provider config, max 50.",
                },
            },
            "required": [],
        },
    }


def _handle_search(provider: AtomicMemoryMemoryProvider, args: dict[str, Any]) -> str:
    query = _clean_str(args.get("query"))
    if not query:
        return tool_error("Missing required parameter: query")
    limit = _bounded_int(args.get("top_k"), provider._config.search_limit, 50)
    kwargs = provider._read_kwargs(limit_override=limit)
    page = provider._require_client().search(query=query, **kwargs)
    if not page.memories:
        return json.dumps({"result": "No relevant memories found.", "count": 0})
    return json.dumps({"results": _serialize_memories(page), "count": page.count or len(page.memories)})


def _handle_context(provider: AtomicMemoryMemoryProvider, args: dict[str, Any]) -> str:
    query = _clean_str(args.get("query"))
    if not query:
        return tool_error("Missing required parameter: query")
    token_budget = _bounded_int(args.get("token_budget"), provider._config.token_budget, 50000)
    kwargs = read_scope_kwargs(memory_scope=provider._config.memory_scope, user_id=provider._user_id)
    package = provider._require_client().package(
        query=query,
        scope=kwargs["scope"],
        token_budget=token_budget,
        source_site=kwargs.get("source_site"),
    )
    return json.dumps(
        {
            "result": package.injection_text,
            "results": _serialize_memories(package),
            "count": package.count or len(package.memories),
            "estimated_context_tokens": package.estimated_context_tokens,
            "citations": package.citations,
        },
    )


def _handle_conclude(provider: AtomicMemoryMemoryProvider, args: dict[str, Any]) -> str:
    conclusion = _clean_str(args.get("conclusion"))
    if not conclusion:
        return tool_error("Missing required parameter: conclusion")
    provider._require_client().ingest_verbatim(
        content=conclusion,
        scope=ingest_scope_dict(user_id=provider._user_id),
        provenance=provider._ingest_provenance(session_id=provider._session_id),
        metadata={"kind": "fact"},
    )
    return json.dumps({"result": "Fact stored."})


def _handle_profile(provider: AtomicMemoryMemoryProvider, args: dict[str, Any]) -> str:
    limit = _bounded_int(args.get("limit"), provider._config.search_limit, 50)
    kwargs = provider._read_kwargs(limit_override=limit)
    page = provider._require_client().list_recent(**kwargs)
    if not page.memories:
        return json.dumps({"result": "No memories stored yet.", "count": 0})
    return json.dumps({"results": _serialize_memories(page), "count": page.count or len(page.memories)})


TOOL_HANDLERS: dict[str, Callable[[AtomicMemoryMemoryProvider, dict[str, Any]], str]] = {
    "atomicmemory_search": _handle_search,
    "atomicmemory_context": _handle_context,
    "atomicmemory_conclude": _handle_conclude,
    "atomicmemory_profile": _handle_profile,
}


def serialize_memories(page: Any) -> list[dict[str, Any]]:
    return _serialize_memories(page)


def format_memory_bullets(page: Any) -> str:
    return "\n".join(f"- {item.content}" for item in page.memories if item.content)


def _serialize_memories(page: Any) -> list[dict[str, Any]]:
    return [
        {
            "id": item.id,
            "memory": item.content,
            "score": item.score,
            "source_site": item.source_site,
            "created_at": item.created_at,
        }
        for item in page.memories
    ]


def _bounded_int(value: Any, default: int, maximum: int) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        result = default
    return max(1, min(result, maximum))


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None
