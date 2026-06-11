"""Shared Langflow input builders (imports lfx). Each call returns fresh Input
instances so components do not share mutable input objects."""

from __future__ import annotations

from lfx.inputs.inputs import (
    DictInput,
    DropdownInput,
    MessageTextInput,
    SecretStrInput,
)

from ._sdk import DEFAULT_API_URL


def connection_inputs() -> list:
    return [
        DropdownInput(
            name="provider",
            display_name="Provider",
            options=["atomicmemory"],
            value="atomicmemory",
            advanced=True,
            info="Memory provider. Phase 1 supports atomicmemory.",
        ),
        MessageTextInput(
            name="api_url",
            display_name="API URL",
            value=DEFAULT_API_URL,
            advanced=True,
            info="AtomicMemory Core base URL.",
        ),
        SecretStrInput(
            name="api_key",
            display_name="API Key",
            value="",
            required=False,
            advanced=True,
            info="API key (optional for local Core). Never put secrets in Provider Config.",
        ),
        DictInput(
            name="provider_config",
            display_name="Provider Config",
            value={},
            advanced=True,
            info="Advanced SDK provider config. Must not contain secrets.",
        ),
    ]


def scope_inputs(*, include_session: bool = True) -> list:
    # NOTE: `namespace` is intentionally NOT exposed in Phase 1. The AtomicMemory
    # Python provider only applies namespace on search/package — ingest/list/delete
    # ignore it — so exposing it would silently break scoping (store/delete would
    # not be namespace-isolated). Re-add only after end-to-end namespace support.
    items = [
        MessageTextInput(
            name="memory_user_id",
            display_name="User ID",
            info="Memory scope. Defaults to the Langflow run user when left blank.",
        ),
    ]
    if include_session:
        items.append(
            MessageTextInput(
                name="memory_session_id",
                display_name="Session ID",
                advanced=True,
                info="Session/thread scope. Defaults to the flow session when blank.",
            )
        )
    return items
