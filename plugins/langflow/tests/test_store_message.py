import unittest
from types import SimpleNamespace

try:
    import lfx  # noqa: F401

    HAS_LFX = True
except Exception:
    HAS_LFX = False

from tests.fakes import FakeBridge


@unittest.skipUnless(HAS_LFX, "Langflow (lfx) not installed")
class TestStoreMessageComponent(unittest.TestCase):
    def _component(self, bridge, **inputs):
        import atomicmemory_langflow._component_base as base
        from atomicmemory_langflow.store_message import AtomicMemoryStoreMessageComponent

        from unittest.mock import patch

        patcher = patch.object(
            base.AtomicMemoryComponentMixin, "_build_bridge", lambda self: bridge
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        comp = AtomicMemoryStoreMessageComponent(_user_id="ctx")
        comp.set_attributes(
            {"provider": "atomicmemory", "api_url": "http://localhost:17350", "api_key": "",
             "provider_config": {}, "memory_user_id": "u1", "memory_session_id": "",
             "namespace": "", "message": "I prefer dark mode", "sender": "User", **inputs}
        )
        return comp

    def test_ingests_messages_payload_with_role_and_provenance(self):
        bridge = FakeBridge(ingest_result=SimpleNamespace(created=["a"], updated=[], unchanged=[]))
        msg = self._component(bridge, sender="Machine").store_message()
        name, payload = bridge.calls[0]
        self.assertEqual(name, "ingest_messages")
        self.assertEqual(payload["messages"], [{"role": "assistant", "content": "I prefer dark mode"}])
        self.assertEqual(payload["scope"], {"user": "u1"})

    def test_outcome_in_session_metadata(self):
        bridge = FakeBridge(ingest_result=SimpleNamespace(created=["a", "b"], updated=["c"], unchanged=[]))
        msg = self._component(bridge).store_message()
        # Validates against the REAL Message model (no generic `metadata` field).
        self.assertEqual(
            msg.session_metadata["atomicmemory"],
            {"created": 2, "updated": 1, "unchanged": 0},
        )

    def test_output_passes_from_message_field_guard(self):
        from lfx.schema.message import MessageResponse

        msg = self._component(FakeBridge()).store_message()
        try:
            MessageResponse.from_message(msg)
        except ValueError as exc:
            self.assertNotIn("required fields", str(exc), "missing text/sender/sender_name")

    def test_oversized_content_raises(self):
        bridge = FakeBridge()
        big = "x" * 100_001
        with self.assertRaises(ValueError):
            self._component(bridge, message=big).store_message()

    def test_blank_content_rejected_before_ingest(self):
        for blank in ("", "   ", "\n\t "):
            bridge = FakeBridge()
            with self.assertRaises(ValueError):
                self._component(bridge, message=blank).store_message()
            self.assertEqual(bridge.calls, [])  # never reached Core


if __name__ == "__main__":
    unittest.main()
