import unittest

try:
    import lfx  # noqa: F401

    HAS_LFX = True
except Exception:
    HAS_LFX = False

from tests.fakes import FakeBridge


@unittest.skipUnless(HAS_LFX, "Langflow (lfx) not installed")
class TestChatMemoryComponent(unittest.TestCase):
    def _component(self, bridge, **inputs):
        import atomicmemory_langflow._component_base as base
        from atomicmemory_langflow.chat_memory import AtomicMemoryChatMemoryComponent

        from unittest.mock import patch

        patcher = patch.object(
            base.AtomicMemoryComponentMixin, "_build_bridge", lambda self: bridge
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        comp = AtomicMemoryChatMemoryComponent(_user_id="ctx-user")
        comp.set_attributes(
            {"provider": "atomicmemory", "api_url": "http://localhost:17350",
             "api_key": "", "provider_config": {}, "memory_user_id": "",
             "memory_session_id": "", "namespace": "", "limit": 5, **inputs}
        )
        return comp

    def test_build_message_history_returns_history_bound_to_scope(self):
        from atomicmemory_langflow._chat_history import AtomicMemoryChatMessageHistory

        bridge = FakeBridge()
        comp = self._component(bridge, memory_user_id="u1")
        history = comp.build_message_history()
        self.assertIsInstance(history, AtomicMemoryChatMessageHistory)
        _ = history.messages
        self.assertEqual(bridge.calls[-1][1]["scope"], {"user": "u1"})

    def test_limit_capped(self):
        bridge = FakeBridge()
        comp = self._component(bridge, memory_user_id="u1", limit=10_000)
        history = comp.build_message_history()
        _ = history.messages
        self.assertLessEqual(bridge.calls[-1][1]["limit"], 100)


if __name__ == "__main__":
    unittest.main()
