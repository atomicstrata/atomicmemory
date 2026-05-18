"""Provider lifecycle + tool handlers tested against FakeAtomicMemoryClient.

No subprocess, no time.sleep. Threaded code is synchronized via threading.Event.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from plugins.hermes import AtomicMemoryMemoryProvider
from plugins.hermes.client import (
    ContextPackage,
    IngestResult,
    ListPage,
    MemoryItem,
    SearchPage,
)
from plugins.hermes.config import SOURCE_SITE
from plugins.hermes.tests.fakes import FakeAtomicMemoryClient


def _make_provider(
    *,
    fake: FakeAtomicMemoryClient,
    env: dict[str, str] | None = None,
    file_overrides: dict | None = None,
) -> tuple[AtomicMemoryMemoryProvider, str]:
    """Construct a provider wired to the given fake client and config."""
    tmp = tempfile.mkdtemp()
    if file_overrides:
        Path(tmp, "atomicmemory.json").write_text(json.dumps(file_overrides), encoding="utf-8")

    if env is not None:
        for key, value in env.items():
            import os

            os.environ[key] = value

    provider = AtomicMemoryMemoryProvider(client_factory=lambda _cfg: fake)
    provider.initialize("session-1", hermes_home=tmp, user_id="u1")
    return provider, tmp


class ReadScopeSharedOmitsSourceSite(unittest.TestCase):
    def test_search_in_shared_mode_does_not_send_source_site(self) -> None:
        fake = FakeAtomicMemoryClient(
            search_response=SearchPage(memories=[MemoryItem(id="m1", content="terse")], count=1),
        )
        provider, _ = _make_provider(fake=fake, file_overrides={"memory_scope": "shared"})

        provider.handle_tool_call("atomicmemory_search", {"query": "answer style"})
        provider.shutdown()

        call = fake.calls_to("search")[0]
        self.assertIsNone(call.kwargs["source_site"])
        self.assertEqual(call.kwargs["scope"], {"user": "u1"})


class ReadScopeSiloedAddsSourceSite(unittest.TestCase):
    def test_search_in_siloed_mode_sends_source_site_hermes(self) -> None:
        fake = FakeAtomicMemoryClient(search_response=SearchPage(count=0))
        provider, _ = _make_provider(fake=fake, file_overrides={"memory_scope": "siloed"})

        provider.handle_tool_call("atomicmemory_search", {"query": "x"})
        provider.shutdown()

        call = fake.calls_to("search")[0]
        self.assertEqual(call.kwargs["source_site"], SOURCE_SITE)


class ProfileUsesSameScopePolicyAsSearch(unittest.TestCase):
    def test_profile_in_siloed_mode_sends_source_site(self) -> None:
        fake = FakeAtomicMemoryClient(list_response=ListPage(count=0))
        provider, _ = _make_provider(fake=fake, file_overrides={"memory_scope": "siloed"})

        provider.handle_tool_call("atomicmemory_profile", {"limit": 3})
        provider.shutdown()

        call = fake.calls_to("list_recent")[0]
        self.assertEqual(call.kwargs["source_site"], SOURCE_SITE)
        self.assertEqual(call.kwargs["scope"], {"user": "u1"})

    def test_profile_in_shared_mode_omits_source_site(self) -> None:
        fake = FakeAtomicMemoryClient(list_response=ListPage(count=0))
        provider, _ = _make_provider(fake=fake, file_overrides={"memory_scope": "shared"})

        provider.handle_tool_call("atomicmemory_profile", {"limit": 3})
        provider.shutdown()

        call = fake.calls_to("list_recent")[0]
        self.assertIsNone(call.kwargs["source_site"])


class ContextToolUsesPackage(unittest.TestCase):
    def test_context_dispatches_to_client_package(self) -> None:
        fake = FakeAtomicMemoryClient(
            package_response=ContextPackage(
                injection_text="- terse",
                memories=[MemoryItem(id="m1", content="terse")],
                count=1,
                estimated_context_tokens=12,
                citations=["m1"],
            ),
        )
        provider, _ = _make_provider(fake=fake)

        raw = provider.handle_tool_call(
            "atomicmemory_context",
            {"query": "answer style", "token_budget": 1500},
        )
        provider.shutdown()

        result = json.loads(raw)
        self.assertEqual(result["result"], "- terse")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["citations"], ["m1"])
        call = fake.calls_to("package")[0]
        self.assertEqual(call.kwargs["token_budget"], 1500)


class ConcludeUsesIngestVerbatim(unittest.TestCase):
    def test_conclude_stamps_provenance_source_hermes(self) -> None:
        fake = FakeAtomicMemoryClient(ingest_response=IngestResult(created=["m1"]))
        provider, _ = _make_provider(fake=fake)

        provider.handle_tool_call("atomicmemory_conclude", {"conclusion": "user prefers terse"})
        provider.shutdown()

        call = fake.calls_to("ingest_verbatim")[0]
        self.assertEqual(call.kwargs["content"], "user prefers terse")
        self.assertEqual(call.kwargs["provenance"].source, "hermes")
        self.assertTrue(call.kwargs["provenance"].source_url.startswith("hermes://session/"))
        self.assertEqual(call.kwargs["metadata"], {"kind": "fact"})


class SyncTurnUsesIngestMessages(unittest.TestCase):
    def test_sync_turn_sends_structured_messages_via_worker(self) -> None:
        fake = FakeAtomicMemoryClient(ingest_response=IngestResult(created=["m1"]))
        provider, _ = _make_provider(fake=fake)

        provider.sync_turn("hello", "hi there", session_id="session-x")
        # shutdown drains the worker, so the ingest call must complete before we assert.
        provider.shutdown()

        call = fake.calls_to("ingest_messages")[0]
        messages = call.kwargs["messages"]
        self.assertEqual(messages[0].role, "user")
        self.assertEqual(messages[0].content, "hello")
        self.assertEqual(messages[1].role, "assistant")
        self.assertEqual(messages[1].content, "hi there")
        self.assertEqual(call.kwargs["provenance"].source, "hermes")
        self.assertEqual(call.kwargs["provenance"].source_url, "hermes://session/session-x")
        self.assertEqual(call.kwargs["metadata"], {"kind": "turn"})


class MemoryModeContextHidesTools(unittest.TestCase):
    def test_get_tool_schemas_returns_empty_list(self) -> None:
        fake = FakeAtomicMemoryClient()
        provider, _ = _make_provider(fake=fake, file_overrides={"memory_mode": "context"})

        try:
            self.assertEqual(provider.get_tool_schemas(), [])
            raw = provider.handle_tool_call("atomicmemory_search", {"query": "x"})
            self.assertIn("disabled", json.loads(raw)["error"])
        finally:
            provider.shutdown()


class MemoryModeToolsDisablesLifecycle(unittest.TestCase):
    def test_tools_mode_skips_prefetch_and_sync(self) -> None:
        fake = FakeAtomicMemoryClient()
        provider, _ = _make_provider(fake=fake, file_overrides={"memory_mode": "tools"})

        provider.queue_prefetch("anything")
        provider.sync_turn("u", "a", session_id="s")
        provider.shutdown()

        self.assertEqual(fake.calls_to("search"), [])
        self.assertEqual(fake.calls_to("package"), [])
        self.assertEqual(fake.calls_to("ingest_messages"), [])


class PrefetchStaleResultDiscarded(unittest.TestCase):
    def test_older_prefetch_does_not_overwrite_newer_one(self) -> None:
        first_started = threading.Event()
        release_first = threading.Event()
        second_done = threading.Event()
        results: list[ContextPackage] = [
            ContextPackage(injection_text="- old context"),
            ContextPackage(injection_text="- new context"),
        ]

        class SlowFake(FakeAtomicMemoryClient):
            calls_count = 0

            def package(self_inner, **kwargs):  # type: ignore[override]
                idx = self_inner.calls_count
                self_inner.calls_count += 1
                if idx == 0:
                    first_started.set()
                    release_first.wait(timeout=2)
                else:
                    second_done.set()
                return results[idx]

        fake = SlowFake()
        provider, _ = _make_provider(fake=fake, file_overrides={"memory_mode": "hybrid"})
        try:
            provider.queue_prefetch("old")
            self.assertTrue(first_started.wait(timeout=1))
            provider.queue_prefetch("new")
            self.assertTrue(second_done.wait(timeout=1))
            release_first.set()
            # Wait for the first thread to also finish so it has a chance to overwrite.
            provider._prefetch_thread.join(timeout=2)  # type: ignore[union-attr]
            text = provider.prefetch("anything")
        finally:
            provider.shutdown()

        self.assertIn("new context", text)
        self.assertNotIn("old context", text)


class HandleToolCallUnknownToolReturnsError(unittest.TestCase):
    def test_unknown_tool_yields_error_payload(self) -> None:
        fake = FakeAtomicMemoryClient()
        provider, _ = _make_provider(fake=fake)
        try:
            raw = provider.handle_tool_call("atomicmemory_unknown", {})
            self.assertIn("Unknown tool", json.loads(raw)["error"])
        finally:
            provider.shutdown()


class HandleToolCallBreakerOpen(unittest.TestCase):
    def test_breaker_open_short_circuits_tool_calls(self) -> None:
        fake = FakeAtomicMemoryClient()
        provider, _ = _make_provider(fake=fake)
        # Trip the breaker at real monotonic time so the cooldown window stays open.
        for _ in range(5):
            provider._breaker.record_failure()
        try:
            raw = provider.handle_tool_call("atomicmemory_search", {"query": "x"})
            self.assertIn("temporarily unavailable", json.loads(raw)["error"])
            # No call to the client because we short-circuited.
            self.assertEqual(fake.calls_to("search"), [])
        finally:
            provider._breaker.record_success()
            provider.shutdown()


class PluginYamlHooksMatchImplementation(unittest.TestCase):
    """Acceptance criterion: plugin.yaml hooks list matches implemented hooks."""

    def test_hooks_present_on_provider(self) -> None:
        plugin_yaml = (Path(__file__).resolve().parents[1] / "plugin.yaml").read_text()
        declared: list[str] = []
        in_hooks = False
        for line in plugin_yaml.splitlines():
            stripped = line.strip()
            if stripped.startswith("hooks:"):
                in_hooks = True
                continue
            if in_hooks:
                if stripped.startswith("- "):
                    declared.append(stripped[2:].strip())
                else:
                    if stripped and not stripped.startswith("#"):
                        break

        for hook in declared:
            self.assertTrue(
                hasattr(AtomicMemoryMemoryProvider, hook),
                f"plugin.yaml declares hook `{hook}` but provider has no such method",
            )


if __name__ == "__main__":
    unittest.main()
