import unittest
from types import SimpleNamespace

from atomicmemory_langflow._sdk import AtomicMemoryBridge
from tests.fakes import FakeClient, fake_factory


def _bridge(client, **kw):
    return AtomicMemoryBridge(
        provider="atomicmemory",
        api_url="http://localhost:17350",
        api_key="k",
        provider_config={},
        client_factory=fake_factory(client),
        **kw,
    )


class TestBridgeOps(unittest.TestCase):
    def test_provider_settings_include_url_and_key(self):
        client = FakeClient()
        _bridge(client).capabilities()
        self.assertEqual(client.providers["atomicmemory"]["apiUrl"], "http://localhost:17350")
        self.assertEqual(client.providers["atomicmemory"]["apiKey"], "k")
        self.assertTrue(client.initialized and client.closed)

    def test_ingest_messages_builds_messages_payload(self):
        client = FakeClient()
        _bridge(client).ingest_messages(
            scope={"user": "u"}, messages=[{"role": "user", "content": "hi"}], metadata={"kind": "turn"}
        )
        name, req = client.calls[0]
        self.assertEqual(name, "ingest")
        self.assertEqual(req["mode"], "messages")
        self.assertEqual(req["scope"], {"user": "u"})
        self.assertEqual(req["messages"], [{"role": "user", "content": "hi"}])
        self.assertEqual(req["provenance"], {"source": "langflow"})

    def test_list_memories_passes_scope_limit(self):
        client = FakeClient(list_pages=[SimpleNamespace(memories=[], cursor=None)])
        _bridge(client).list_memories(scope={"user": "u"}, limit=7)
        self.assertEqual(client.calls[0], ("list", {"scope": {"user": "u"}, "limit": 7}))

    def test_delete_scope_pages_then_deletes(self):
        page1 = SimpleNamespace(memories=[SimpleNamespace(id="a"), SimpleNamespace(id="b")], cursor="c1")
        page2 = SimpleNamespace(memories=[SimpleNamespace(id="c")], cursor=None)
        client = FakeClient(list_pages=[page1, page2])
        summary = _bridge(client).delete_scope(scope={"user": "u"})
        self.assertEqual(summary, {"deleted": 3, "failed": 0, "found": 3})
        self.assertEqual([r["id"] for r in client.deleted], ["a", "b", "c"])

    def test_client_closed_even_if_initialize_fails(self):
        class BoomClient(FakeClient):
            def initialize(self):
                self.initialized = False
                raise RuntimeError("boom")

        client = BoomClient()
        with self.assertRaises(RuntimeError):
            _bridge(client).capabilities()
        self.assertTrue(client.closed)

    def test_blank_api_key_omitted_from_settings(self):
        client = FakeClient()
        AtomicMemoryBridge(
            provider="atomicmemory",
            api_url="http://localhost:17350",
            api_key="   ",
            provider_config={},
            client_factory=fake_factory(client),
        ).capabilities()
        self.assertNotIn("apiKey", client.providers["atomicmemory"])


if __name__ == "__main__":
    unittest.main()
