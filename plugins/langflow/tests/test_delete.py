import unittest

try:
    import lfx  # noqa: F401

    HAS_LFX = True
except Exception:
    HAS_LFX = False

from tests.fakes import FakeBridge


@unittest.skipUnless(HAS_LFX, "Langflow (lfx) not installed")
class TestDeleteComponent(unittest.TestCase):
    def _component(self, bridge, **inputs):
        import atomicmemory_langflow._component_base as base
        from atomicmemory_langflow.delete import AtomicMemoryDeleteComponent

        from unittest.mock import patch

        patcher = patch.object(
            base.AtomicMemoryComponentMixin, "_build_bridge", lambda self: bridge
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        comp = AtomicMemoryDeleteComponent(_user_id="ctx")
        comp.set_attributes(
            {"provider": "atomicmemory", "api_url": "http://localhost:17350", "api_key": "",
             "provider_config": {}, "memory_user_id": "u1", "memory_session_id": "",
             "namespace": "", "confirm": False, **inputs}
        )
        return comp

    def test_confirm_false_is_noop(self):
        bridge = FakeBridge()
        msg = self._component(bridge, confirm=False).delete()
        self.assertEqual(bridge.calls, [])
        self.assertIn("skipped", msg.text.lower())

    def test_outputs_pass_from_message_field_guard(self):
        # Both the skipped and deleted messages must carry text+sender+sender_name
        # so they pass MessageResponse.from_message's required-fields guard.
        from lfx.schema.message import MessageResponse

        for confirm in (False, True):
            msg = self._component(FakeBridge(), confirm=confirm).delete()
            try:
                MessageResponse.from_message(msg)
            except ValueError as exc:
                self.assertNotIn("required fields", str(exc), "missing text/sender/sender_name")

    def test_confirm_true_calls_delete_scope(self):
        bridge = FakeBridge()
        msg = self._component(bridge, confirm=True).delete()
        self.assertEqual(bridge.calls[0], ("delete_scope", {"scope": {"user": "u1"}}))
        self.assertIn("2", msg.text)


if __name__ == "__main__":
    unittest.main()
