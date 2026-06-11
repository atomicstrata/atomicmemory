import unittest
from types import SimpleNamespace

try:
    import lfx  # noqa: F401

    HAS_LFX = True
except Exception:
    HAS_LFX = False

from tests.fakes import FakeBridge


def _caps(package: bool):
    return SimpleNamespace(extensions=SimpleNamespace(package=package))


@unittest.skipUnless(HAS_LFX, "Langflow (lfx) not installed")
class TestSearchContextComponent(unittest.TestCase):
    def _component(self, bridge, **inputs):
        import atomicmemory_langflow._component_base as base
        from atomicmemory_langflow.search_context import AtomicMemorySearchContextComponent

        from unittest.mock import patch

        patcher = patch.object(
            base.AtomicMemoryComponentMixin, "_build_bridge", lambda self: bridge
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        comp = AtomicMemorySearchContextComponent(_user_id="ctx")
        comp.set_attributes(
            {"provider": "atomicmemory", "api_url": "http://localhost:17350", "api_key": "",
             "provider_config": {}, "memory_user_id": "u1", "memory_session_id": "",
             "namespace": "", "query": "what do I like?", "limit": 5,
             "use_packaged_context": True, "scope_to_session": False, **inputs}
        )
        return comp

    def test_packaged_context_returns_package_text(self):
        bridge = FakeBridge(capabilities=_caps(True), package_text="PACKAGED CONTEXT")
        msg = self._component(bridge).build_context()
        self.assertEqual(msg.text, "PACKAGED CONTEXT")

    def test_recall_is_user_scoped_by_default(self):
        # Even with a session present, default recall omits thread (cross-session).
        bridge = FakeBridge(capabilities=_caps(True))
        self._component(bridge, memory_session_id="sess-b").build_context()
        scope = bridge.calls[-1][1]["scope"]
        self.assertEqual(scope, {"user": "u1"})

    def test_scope_to_session_includes_thread(self):
        bridge = FakeBridge(capabilities=_caps(True))
        self._component(bridge, memory_session_id="sess-b", scope_to_session=True).build_context()
        scope = bridge.calls[-1][1]["scope"]
        self.assertEqual(scope, {"user": "u1", "thread": "sess-b"})

    def test_output_passes_from_message_field_guard(self):
        # Langflow persistence (MessageResponse.from_message) rejects messages
        # missing text/sender/sender_name. With sender set we get past that guard;
        # later pydantic field quirks in standalone lfx (timestamp/edit) are out of scope.
        from lfx.schema.message import MessageResponse

        bridge = FakeBridge(capabilities=_caps(True), package_text="ctx")
        msg = self._component(bridge).build_context()
        try:
            MessageResponse.from_message(msg)
        except ValueError as exc:
            self.assertNotIn("required fields", str(exc), "missing text/sender/sender_name")

    def test_unsupported_package_raises(self):
        bridge = FakeBridge(capabilities=_caps(False))
        with self.assertRaises(ValueError):
            self._component(bridge).build_context()

    def test_search_only_mode_when_flag_false(self):
        bridge = FakeBridge(capabilities=_caps(False))
        msg = self._component(bridge, use_packaged_context=False).build_context()
        self.assertIn("search", [c[0] for c in bridge.calls])
        self.assertIsNotNone(msg.text)

    def test_blank_query_raises(self):
        bridge = FakeBridge(capabilities=_caps(True))
        with self.assertRaises(ValueError):
            self._component(bridge, query="   ").build_context()

    def test_limit_is_clamped(self):
        from atomicmemory_langflow.search_context import MAX_SEARCH_LIMIT

        def limit_for(value):
            bridge = FakeBridge(capabilities=_caps(False))
            self._component(bridge, use_packaged_context=False, limit=value).build_context()
            return bridge.calls[0][1]["limit"]

        self.assertEqual(limit_for(10_000), MAX_SEARCH_LIMIT)
        self.assertEqual(limit_for(0), 1)
        self.assertEqual(limit_for(-5), 1)
        self.assertEqual(limit_for(7), 7)


if __name__ == "__main__":
    unittest.main()
