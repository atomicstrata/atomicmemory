"""Config + scope policy for the Hermes provider.

Single helper `read_scope()` is the only place that decides whether a read
includes `source_site=hermes`. Every read tool funnels through it, so the
v1-round-1 asymmetry (profile vs search) cannot recur by construction.

Source attribution on writes always lives in provenance, never in scope.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


SOURCE_SITE = "hermes"
DEFAULT_USER_ID = "hermes-user"
DEFAULT_AGENT_ID = "hermes"
DEFAULT_SEARCH_LIMIT = 5
DEFAULT_TOKEN_BUDGET = 4000
DEFAULT_MEMORY_MODE = "hybrid"
DEFAULT_MEMORY_SCOPE = "shared"
DEFAULT_PREFETCH_METHOD = "context"

VALID_MEMORY_MODES = {"hybrid", "context", "tools"}
VALID_MEMORY_SCOPES = {"shared", "siloed"}
VALID_PREFETCH_METHODS = {"context", "fast"}

CONFIG_FILE_KEYS = {
    "scope_user",
    "scope_agent",
    "search_limit",
    "token_budget",
    "prefetch_enabled",
    "memory_mode",
    "memory_scope",
    "prefetch_method",
}
"""Keys allowed in $HERMES_HOME/atomicmemory.json.

`api_url`/`api_key` are intentionally absent: SDK connection config lives in env.
No hardcoded service endpoints.
"""


@dataclass
class ProviderConfig:
    scope_user: str = DEFAULT_USER_ID
    scope_agent: str = DEFAULT_AGENT_ID
    search_limit: int = DEFAULT_SEARCH_LIMIT
    token_budget: int = DEFAULT_TOKEN_BUDGET
    prefetch_enabled: bool = True
    memory_mode: str = DEFAULT_MEMORY_MODE
    memory_scope: str = DEFAULT_MEMORY_SCOPE
    prefetch_method: str = DEFAULT_PREFETCH_METHOD


def load_config(
    *,
    hermes_home: str | Path | None = None,
    env: dict[str, str] | None = None,
) -> ProviderConfig:
    env = env if env is not None else os.environ.copy()
    cfg = ProviderConfig(
        scope_user=_clean(env.get("ATOMICMEMORY_SCOPE_USER"))
        or _clean(env.get("USER"))
        or _clean(env.get("USERNAME"))
        or DEFAULT_USER_ID,
        scope_agent=_clean(env.get("ATOMICMEMORY_SCOPE_AGENT")) or DEFAULT_AGENT_ID,
        search_limit=_env_int(env, "ATOMICMEMORY_SEARCH_LIMIT", DEFAULT_SEARCH_LIMIT),
        token_budget=_env_int(env, "ATOMICMEMORY_TOKEN_BUDGET", DEFAULT_TOKEN_BUDGET),
        prefetch_enabled=_env_bool(env, "ATOMICMEMORY_PREFETCH_ENABLED", True),
        memory_mode=_normalized(env.get("ATOMICMEMORY_MEMORY_MODE"), DEFAULT_MEMORY_MODE, VALID_MEMORY_MODES),
        memory_scope=_normalized(
            env.get("ATOMICMEMORY_MEMORY_SCOPE"), DEFAULT_MEMORY_SCOPE, VALID_MEMORY_SCOPES,
        ),
        prefetch_method=_normalized(
            env.get("ATOMICMEMORY_PREFETCH_METHOD"), DEFAULT_PREFETCH_METHOD, VALID_PREFETCH_METHODS,
        ),
    )
    file_overrides = _read_config_file(hermes_home)
    return _apply_file_overrides(cfg, file_overrides)


def save_config(values: dict[str, Any], hermes_home: str | Path) -> None:
    """Persist non-secret advanced config to $HERMES_HOME/atomicmemory.json."""
    path = Path(hermes_home) / "atomicmemory.json"
    existing: dict[str, Any] = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                existing = {k: v for k, v in raw.items() if k in CONFIG_FILE_KEYS}
        except Exception:  # noqa: BLE001
            existing = {}
    for key, value in values.items():
        if key not in CONFIG_FILE_KEYS:
            continue
        if value is None or value == "":
            continue
        existing[key] = value
    path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")


def get_config_schema() -> list[dict[str, Any]]:
    """Setup-wizard prompts. Keep minimal — advanced knobs go in the JSON file."""
    return [
        {
            "key": "scope_user",
            "description": "User identity for AtomicMemory recall and ingest scope.",
            "default": DEFAULT_USER_ID,
            "env_var": "ATOMICMEMORY_SCOPE_USER",
        },
        {
            "key": "memory_scope",
            "description": (
                "shared (default): cross-tool recall — Hermes sees memories from every "
                "AtomicMemory tool. siloed: Hermes sees only Hermes-ingested memories."
            ),
            "default": DEFAULT_MEMORY_SCOPE,
            "env_var": "ATOMICMEMORY_MEMORY_SCOPE",
            "enum": sorted(VALID_MEMORY_SCOPES),
        },
    ]


def read_scope_kwargs(*, memory_scope: str, user_id: str) -> dict[str, Any]:
    """Build kwargs for AtomicMemoryClient.search/package/list_recent.

    Single source of truth for whether a read includes `source_site=hermes`.
    Used by `atomicmemory_search`, `atomicmemory_context`, `atomicmemory_profile`,
    and `_prefetch_context`.
    """
    base: dict[str, Any] = {"scope": {"user": user_id}}
    if memory_scope == "siloed":
        base["source_site"] = SOURCE_SITE
    return base


def ingest_scope_dict(*, user_id: str) -> dict[str, Any]:
    """Scope for ingest. Source attribution lives in provenance, not scope."""
    return {"user": user_id}


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _env_int(env: dict[str, str], name: str, default: int) -> int:
    raw = _clean(env.get(name))
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_bool(env: dict[str, str], name: str, default: bool) -> bool:
    raw = _clean(env.get(name))
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _normalized(value: Any, default: str, allowed: set[str]) -> str:
    cleaned = (_clean(value) or default).lower()
    return cleaned if cleaned in allowed else default


def _read_config_file(hermes_home: str | Path | None) -> dict[str, Any]:
    if hermes_home is None:
        hermes_home = _hermes_home()
    path = Path(hermes_home) / "atomicmemory.json"
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to read AtomicMemory config: %s", exc)
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in CONFIG_FILE_KEYS and v not in (None, "")}


def _apply_file_overrides(cfg: ProviderConfig, file_overrides: dict[str, Any]) -> ProviderConfig:
    if "scope_user" in file_overrides:
        cfg.scope_user = str(file_overrides["scope_user"])
    if "scope_agent" in file_overrides:
        cfg.scope_agent = str(file_overrides["scope_agent"])
    if "search_limit" in file_overrides:
        cfg.search_limit = _coerce_positive_int(file_overrides["search_limit"], cfg.search_limit)
    if "token_budget" in file_overrides:
        cfg.token_budget = _coerce_positive_int(file_overrides["token_budget"], cfg.token_budget, lower=100)
    if "prefetch_enabled" in file_overrides:
        cfg.prefetch_enabled = bool(file_overrides["prefetch_enabled"])
    if "memory_mode" in file_overrides:
        cfg.memory_mode = _normalized(file_overrides["memory_mode"], cfg.memory_mode, VALID_MEMORY_MODES)
    if "memory_scope" in file_overrides:
        cfg.memory_scope = _normalized(file_overrides["memory_scope"], cfg.memory_scope, VALID_MEMORY_SCOPES)
    if "prefetch_method" in file_overrides:
        cfg.prefetch_method = _normalized(
            file_overrides["prefetch_method"], cfg.prefetch_method, VALID_PREFETCH_METHODS,
        )
    cfg.search_limit = max(1, min(cfg.search_limit, 50))
    cfg.token_budget = max(100, cfg.token_budget)
    return cfg


def _coerce_positive_int(value: Any, default: int, *, lower: int = 1) -> int:
    try:
        coerced = int(value)
    except (TypeError, ValueError):
        return default
    return coerced if coerced >= lower else default


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore[import-not-found]

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 — used only outside Hermes test runs
        return Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
