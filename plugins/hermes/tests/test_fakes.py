"""Smoke tests for FakeAtomicMemoryClient — proves the recorder shape works."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from plugins.hermes.client import (
    BridgeError,
    ContextPackage,
    IngestResult,
    ListPage,
    Message,
    Provenance,
    SearchPage,
)
from plugins.hermes.tests.fakes import FakeAtomicMemoryClient, make_memory


class FakeRecordsSearch(unittest.TestCase):
    def test_search_records_kwargs_and_returns_canned_page(self) -> None:
        fake = FakeAtomicMemoryClient(
            search_response=SearchPage(memories=[make_memory("hi")], count=1),
        )

        page = fake.search(query="q", scope={"user": "u1"}, limit=3, source_site="hermes")

        self.assertEqual(page.count, 1)
        self.assertEqual(page.memories[0].content, "hi")
        call = fake.calls_to("search")[0]
        self.assertEqual(call.kwargs["query"], "q")
        self.assertEqual(call.kwargs["scope"], {"user": "u1"})
        self.assertEqual(call.kwargs["limit"], 3)
        self.assertEqual(call.kwargs["source_site"], "hermes")


class FakeRecordsPackage(unittest.TestCase):
    def test_package_records_token_budget(self) -> None:
        fake = FakeAtomicMemoryClient(
            package_response=ContextPackage(injection_text="- one"),
        )

        pkg = fake.package(query="q", scope={"user": "u1"}, token_budget=1000)

        self.assertEqual(pkg.injection_text, "- one")
        call = fake.calls_to("package")[0]
        self.assertEqual(call.kwargs["token_budget"], 1000)
        self.assertIsNone(call.kwargs["source_site"])


class FakeRecordsListRecent(unittest.TestCase):
    def test_list_recent_records_kwargs(self) -> None:
        fake = FakeAtomicMemoryClient(
            list_response=ListPage(memories=[make_memory("recent")], count=1),
        )

        page = fake.list_recent(scope={"user": "u1"}, limit=5, source_site="hermes")

        self.assertEqual(page.count, 1)
        call = fake.calls_to("list_recent")[0]
        self.assertEqual(call.kwargs["limit"], 5)
        self.assertEqual(call.kwargs["source_site"], "hermes")


class FakeRecordsIngestMessages(unittest.TestCase):
    def test_ingest_messages_captures_provenance(self) -> None:
        fake = FakeAtomicMemoryClient(ingest_response=IngestResult(created=["m1"]))
        prov = Provenance(source="hermes", source_url="hermes://session/abc")

        result = fake.ingest_messages(
            messages=[Message(role="user", content="hi")],
            scope={"user": "u1"},
            provenance=prov,
            metadata={"kind": "turn"},
        )

        self.assertEqual(result.created, ["m1"])
        call = fake.calls_to("ingest_messages")[0]
        self.assertEqual(call.kwargs["provenance"], prov)
        self.assertEqual(call.kwargs["metadata"], {"kind": "turn"})


class FakeRecordsIngestVerbatim(unittest.TestCase):
    def test_ingest_verbatim_captures_content(self) -> None:
        fake = FakeAtomicMemoryClient()

        fake.ingest_verbatim(
            content="user prefers terse answers",
            scope={"user": "u1"},
            provenance=Provenance(source="hermes"),
        )

        call = fake.calls_to("ingest_verbatim")[0]
        self.assertEqual(call.kwargs["content"], "user prefers terse answers")


class FakeLifecycleCounters(unittest.TestCase):
    def test_initialize_and_shutdown_increment(self) -> None:
        fake = FakeAtomicMemoryClient()

        fake.initialize()
        fake.initialize()
        fake.shutdown()

        self.assertEqual(fake.initialized, 2)
        self.assertEqual(fake.shutdown_called, 1)


class FakeRaiseOnInjects(unittest.TestCase):
    def test_raise_on_triggers_client_error_once(self) -> None:
        fake = FakeAtomicMemoryClient(raise_on="search")

        with self.assertRaises(BridgeError):
            fake.search(query="q", scope={"user": "u1"}, limit=1)
        # Only first call raises; subsequent calls succeed.
        page = fake.search(query="q2", scope={"user": "u1"}, limit=1)

        self.assertIsInstance(page, SearchPage)


if __name__ == "__main__":
    unittest.main()
