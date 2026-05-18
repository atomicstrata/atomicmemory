"""Tests for the Python SDK-backed Hermes client adapter."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from plugins.hermes.client import BridgeError, Message, Provenance, ProviderUnsupportedError
from plugins.hermes.python_sdk import (
    PythonSdkAtomicMemoryClient,
    PythonSdkConfig,
    PythonSdkTypes,
    _load_sdk_types,
)


class PythonSdkAdapterRouting(unittest.TestCase):
    def test_initialize_is_idempotent(self) -> None:
        client, sdk = _client_with_fakes()

        client.initialize()

        self.assertEqual(FakeMemoryClient.constructed, 1)
        self.assertEqual(sdk.calls.count(("initialize",)), 1)

    def test_shutdown_closes_client_and_clears_reference(self) -> None:
        client, sdk = _client_with_fakes()

        client.shutdown()

        self.assertIn(("close",), sdk.calls)
        with self.assertRaises(BridgeError):
            client.search(query="q", scope={"user": "u1"}, limit=3)

    def test_shared_search_uses_generic_client(self) -> None:
        client, sdk = _client_with_fakes()

        page = client.search(query="q", scope={"user": "u1"}, limit=3)

        self.assertEqual(sdk.calls[-1], ("search", {"query": "q", "scope": {"user": "u1"}, "limit": 3}))
        self.assertEqual(page.memories[0].content, "generic")

    def test_siloed_package_uses_atomic_search_with_source_site(self) -> None:
        client, sdk = _client_with_fakes()

        package = client.package(query="q", scope={"user": "u1"}, token_budget=700, source_site="hermes")

        method, request, scope = sdk.atomicmemory.calls[0]
        self.assertEqual(method, "search")
        self.assertEqual(request.retrieval_mode, "tiered")
        self.assertEqual(request.skip_repair, True)
        self.assertEqual(request.token_budget, 700)
        self.assertEqual(request.source_site, "hermes")
        self.assertEqual(scope.user_id, "u1")
        self.assertEqual(package.injection_text, "atomic package")

    def test_siloed_list_uses_atomic_list_with_source_site(self) -> None:
        client, sdk = _client_with_fakes()

        client.list_recent(scope={"user": "u1"}, limit=5, source_site="hermes")

        method, scope, options = sdk.atomicmemory.calls[0]
        self.assertEqual(method, "list")
        self.assertEqual(scope.user_id, "u1")
        self.assertEqual(options.limit, 5)
        self.assertEqual(options.source_site, "hermes")

    def test_ingest_messages_uses_generic_sdk_ingest(self) -> None:
        client, sdk = _client_with_fakes()

        client.ingest_messages(
            messages=[Message(role="user", content="hello")],
            scope={"user": "u1"},
            provenance=Provenance(source="hermes", source_url="hermes://session/s1"),
        )

        method, payload = sdk.calls[-1]
        self.assertEqual(method, "ingest")
        self.assertEqual(payload["mode"], "messages")
        self.assertEqual(payload["provenance"]["source"], "hermes")

    def test_source_site_requires_atomicmemory_namespace(self) -> None:
        client, _sdk = _client_with_fakes(has_atomic=False)

        with self.assertRaises(ProviderUnsupportedError):
            client.search(query="q", scope={"user": "u1"}, limit=3, source_site="hermes")


class PythonSdkPathResolution(unittest.TestCase):
    def test_loader_survives_plugin_named_atomicmemory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_parent = Path(tmp) / "plugins"
            plugin_root = plugin_parent / "atomicmemory"
            plugin_root.mkdir(parents=True)
            sdk_root = _write_fake_sdk(Path(tmp) / "site-packages")
            plugin_module = SimpleNamespace(__file__=str(plugin_root / "__init__.py"))
            prior = _stash_atomicmemory_modules()
            sys.modules["atomicmemory"] = plugin_module
            prior_path = list(sys.path)
            sys.path.insert(0, str(sdk_root))
            sys.path.insert(0, str(plugin_parent))
            try:
                types = _load_sdk_types()
            finally:
                sys.modules.pop("atomicmemory", None)
                _restore_atomicmemory_modules(prior)
                sys.path[:] = prior_path

        self.assertEqual(types.MemoryClient.__name__, "MemoryClient")
        self.assertIs(sys.modules.get("atomicmemory"), prior.get("atomicmemory"))
        self.assertEqual(sys.path, prior_path)

    def test_loader_survives_cached_published_sdk_modules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sdk_root = _write_fake_sdk(Path(tmp) / "site-packages")
            prior = _stash_atomicmemory_modules()
            prior_path = list(sys.path)
            sys.path.insert(0, str(sdk_root))
            try:
                first = _load_sdk_types()
                second = _load_sdk_types()
            finally:
                _restore_atomicmemory_modules(prior)
                sys.path[:] = prior_path

        self.assertEqual(first.MemoryClient.__name__, "MemoryClient")
        self.assertEqual(second.MemoryClient.__name__, "MemoryClient")


def _client_with_fakes(*, has_atomic: bool = True) -> tuple[PythonSdkAtomicMemoryClient, "FakeMemoryClient"]:
    FakeMemoryClient.next_has_atomic = has_atomic
    FakeMemoryClient.constructed = 0
    client = PythonSdkAtomicMemoryClient(
        config=PythonSdkConfig(api_url="http://core.test"),
        sdk_types=PythonSdkTypes(
            MemoryClient=FakeMemoryClient,
            UserScope=FakeUserScope,
            AtomicMemorySearchRequest=FakeAtomicSearchRequest,
            AtomicMemoryListOptions=FakeAtomicListOptions,
        ),
    )
    client.initialize()
    return client, FakeMemoryClient.last_instance


class FakeMemoryClient:
    last_instance: "FakeMemoryClient"
    next_has_atomic = True
    constructed = 0

    def __init__(self, providers: dict, default_provider: str) -> None:
        FakeMemoryClient.constructed += 1
        self.providers = providers
        self.default_provider = default_provider
        self.calls: list[tuple] = []
        self.atomicmemory = FakeAtomicNamespace() if self.next_has_atomic else None
        FakeMemoryClient.last_instance = self

    def initialize(self) -> None:
        self.calls.append(("initialize",))

    def close(self) -> None:
        self.calls.append(("close",))

    def search(self, request: dict) -> SimpleNamespace:
        self.calls.append(("search", request))
        return SimpleNamespace(results=[_hit("generic")])

    def package(self, request: dict) -> SimpleNamespace:
        self.calls.append(("package", request))
        return SimpleNamespace(text="generic package", tokens=12, results=[_hit("generic")])

    def list(self, request: dict) -> SimpleNamespace:
        self.calls.append(("list", request))
        return SimpleNamespace(memories=[_memory("generic")])

    def ingest(self, payload: dict) -> SimpleNamespace:
        self.calls.append(("ingest", payload))
        return SimpleNamespace(created=["m1"], updated=[], unchanged=[])


class FakeAtomicNamespace:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def search(self, request: "FakeAtomicSearchRequest", scope: "FakeUserScope") -> SimpleNamespace:
        self.calls.append(("search", request, scope))
        return SimpleNamespace(
            injection_text="atomic package",
            estimated_context_tokens=20,
            citations=["m1"],
            count=1,
            results=[_hit("atomic", source_site="hermes")],
        )

    def list(self, scope: "FakeUserScope", options: "FakeAtomicListOptions") -> SimpleNamespace:
        self.calls.append(("list", scope, options))
        return SimpleNamespace(count=1, memories=[_memory("atomic", source_site=options.source_site)])


class FakeUserScope(SimpleNamespace):
    pass


class FakeAtomicSearchRequest(SimpleNamespace):
    pass


class FakeAtomicListOptions(SimpleNamespace):
    pass


def _hit(content: str, *, source_site: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(memory=_memory(content, source_site=source_site), score=0.9)


def _memory(content: str, *, source_site: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        id=f"{content}-id",
        content=content,
        source_site=source_site,
        provenance=SimpleNamespace(source=source_site),
        created_at="2026-05-08T00:00:00Z",
    )


def _write_fake_sdk(root: Path) -> Path:
    (root / "atomicmemory" / "providers" / "atomicmemory").mkdir(parents=True)
    (root / "atomicmemory" / "__init__.py").write_text(
        "class MemoryClient:\n    pass\n",
        encoding="utf-8",
    )
    for path in [
        root / "atomicmemory" / "providers" / "__init__.py",
        root / "atomicmemory" / "providers" / "atomicmemory" / "__init__.py",
    ]:
        path.write_text("", encoding="utf-8")
    (root / "atomicmemory" / "providers" / "atomicmemory" / "handle.py").write_text(
        "class UserScope:\n    pass\n"
        "class AtomicMemorySearchRequest:\n    pass\n"
        "class AtomicMemoryListOptions:\n    pass\n",
        encoding="utf-8",
    )
    return root


def _stash_atomicmemory_modules() -> dict[str, object]:
    saved = {}
    for name, module in list(sys.modules.items()):
        if name == "atomicmemory" or name.startswith("atomicmemory."):
            saved[name] = sys.modules.pop(name)
    return saved


def _restore_atomicmemory_modules(saved: dict[str, object]) -> None:
    for name in list(sys.modules):
        if name == "atomicmemory" or name.startswith("atomicmemory."):
            sys.modules.pop(name)
    sys.modules.update(saved)


if __name__ == "__main__":
    unittest.main()
