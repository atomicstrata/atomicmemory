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
    def test_cloud_api_key_is_normalized_before_validation(self) -> None:
        blank = PythonSdkConfig(api_key="   ")
        padded = PythonSdkConfig(api_key="  amc_padded_test  ")

        self.assertIsNone(blank.api_key)
        self.assertEqual(padded.api_key, "amc_padded_test")

    def test_cloud_url_normalization_cannot_bypass_required_key(self) -> None:
        urls = [
            " https://api.atomicstrata.ai/ ",
            "https://API.atomicstrata.ai",
            "https://api.atomicstrata.ai:443/v1",
            "https://api.dev.atomicstrata.ai",
            "https://api.staging.atomicstrata.ai",
            "https://api。atomicstrata。ai",
            "https://api．atomicstrata．ai",
            "https://api｡atomicstrata｡ai",
            "https://ａｐｉ.atomicstrata.ai",
            "https://ⓐⓟⓘ.atomicstrata.ai",
        ]
        for api_url in urls:
            with self.subTest(api_url=api_url):
                client = PythonSdkAtomicMemoryClient(
                    config=PythonSdkConfig(api_url=api_url),
                    sdk_types=PythonSdkTypes(
                        MemoryClient=FakeMemoryClient,
                        UserScope=FakeUserScope,
                        AtomicMemorySearchRequest=FakeAtomicSearchRequest,
                        AtomicMemoryListOptions=FakeAtomicListOptions,
                    ),
                )
                with self.assertRaisesRegex(BridgeError, "API_KEY is required"):
                    client.initialize()

    def test_missing_cloud_key_error_points_local_core_users_at_local_url(self) -> None:
        client = PythonSdkAtomicMemoryClient(config=PythonSdkConfig(), sdk_types=_fake_types())
        with self.assertRaisesRegex(BridgeError, r"ATOMICMEMORY_API_URL=http://127\.0\.0\.1:17350"):
            client.initialize()

    def test_local_core_key_is_refused_for_cloud_origins(self) -> None:
        urls = [
            "https://api.atomicstrata.ai",
            "https://API.atomicstrata.ai:443/v1",
            "https://api.dev.atomicstrata.ai",
            "https://api.staging.atomicstrata.ai",
        ]
        for api_url in urls:
            for api_key in ["local-dev-key", "  local-dev-key  "]:
                with self.subTest(api_url=api_url, api_key=api_key):
                    FakeMemoryClient.constructed = 0
                    client = PythonSdkAtomicMemoryClient(
                        config=PythonSdkConfig(api_url=api_url, api_key=api_key),
                        sdk_types=_fake_types(),
                    )
                    with self.assertRaisesRegex(
                        BridgeError,
                        r"local Core key.*ATOMICMEMORY_API_URL=http://127\.0\.0\.1:17350",
                    ):
                        client.initialize()
                    self.assertEqual(FakeMemoryClient.constructed, 0)

    def test_plain_http_to_cloud_hostname_fails_closed(self) -> None:
        urls = [
            "http://api.atomicstrata.ai",
            "HTTP://API.atomicstrata.ai:80/v1",
            "http://api.dev.atomicstrata.ai:8080",
            "http://api.staging.atomicstrata.ai.",
        ]
        for api_url in urls:
            with self.subTest(api_url=api_url):
                FakeMemoryClient.constructed = 0
                client = PythonSdkAtomicMemoryClient(
                    config=PythonSdkConfig(api_url=api_url, api_key="amc_cloud_test"),
                    sdk_types=_fake_types(),
                )
                with self.assertRaisesRegex(BridgeError, "must use https"):
                    client.initialize()
                self.assertEqual(FakeMemoryClient.constructed, 0)

    def test_local_core_url_defaults_to_local_dev_key(self) -> None:
        for api_url in [
            "http://127.0.0.1:17350",
            "http://localhost:17350/",
            "HTTP://LOCALHOST:17350",
            "http://localhost:017350",
        ]:
            with self.subTest(api_url=api_url):
                self.assertEqual(PythonSdkConfig(api_url=api_url).api_key, "local-dev-key")
                self.assertEqual(
                    PythonSdkConfig(api_url=api_url, api_key="  ").api_key, "local-dev-key"
                )

    def test_local_dev_key_is_never_synthesized_elsewhere(self) -> None:
        cases = [
            PythonSdkConfig(),
            PythonSdkConfig(api_url="https://api.atomicstrata.ai"),
            PythonSdkConfig(api_url="https://memory.example.com"),
            PythonSdkConfig(api_url="http://127.0.0.1:8080"),
            PythonSdkConfig(api_url="https://127.0.0.1:17350"),
            PythonSdkConfig(provider="mem0", api_url="http://127.0.0.1:17350"),
        ]
        for config in cases:
            with self.subTest(provider=config.provider, api_url=config.api_url):
                self.assertIsNone(config.api_key)

    def test_local_core_initializes_with_local_dev_key(self) -> None:
        client = PythonSdkAtomicMemoryClient(
            config=PythonSdkConfig(api_url="http://127.0.0.1:17350"),
            sdk_types=_fake_types(),
        )
        client.initialize()
        self.assertEqual(
            FakeMemoryClient.last_instance.providers["atomicmemory"],
            {"api_url": "http://127.0.0.1:17350", "api_key": "local-dev-key"},
        )
        client.shutdown()

    def test_default_config_targets_atomicmemory_cloud(self) -> None:
        config = PythonSdkConfig(api_key="amc_cloud_test")
        client = PythonSdkAtomicMemoryClient(
            config=config,
            sdk_types=PythonSdkTypes(
                MemoryClient=FakeMemoryClient,
                UserScope=FakeUserScope,
                AtomicMemorySearchRequest=FakeAtomicSearchRequest,
                AtomicMemoryListOptions=FakeAtomicListOptions,
            ),
        )

        client.initialize()
        client.ingest_messages(
            messages=[Message(role="user", content="prefers concise answers")],
            scope={"user": "u1"},
            provenance=Provenance(source="hermes"),
        )
        page = client.search(query="answer preference", scope={"user": "u1"}, limit=3)

        self.assertEqual(
            FakeMemoryClient.last_instance.providers["atomicmemory"],
            {"api_url": "https://api.atomicstrata.ai", "api_key": "amc_cloud_test"},
        )
        self.assertEqual(page.memories[0].content, "generic")
        self.assertEqual(
            [call[0] for call in FakeMemoryClient.last_instance.calls],
            ["initialize", "ingest", "search"],
        )
        client.shutdown()

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


def _fake_types() -> PythonSdkTypes:
    return PythonSdkTypes(
        MemoryClient=FakeMemoryClient,
        UserScope=FakeUserScope,
        AtomicMemorySearchRequest=FakeAtomicSearchRequest,
        AtomicMemoryListOptions=FakeAtomicListOptions,
    )


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
