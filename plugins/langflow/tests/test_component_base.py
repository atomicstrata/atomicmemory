import unittest

from atomicmemory_langflow._component_base import AtomicMemoryComponentMixin


class _Host(AtomicMemoryComponentMixin):
    """Minimal stand-in exposing the attributes the mixin reads."""

    def __init__(self, **attrs):
        self.__dict__.update(attrs)


class TestMixin(unittest.TestCase):
    def test_explicit_user_id_wins(self):
        host = _Host(memory_user_id="explicit", user_id="ctx")
        self.assertEqual(host._resolve_user_id(), "explicit")

    def test_falls_back_to_run_context_user(self):
        host = _Host(memory_user_id="", user_id="ctx-user")
        self.assertEqual(host._resolve_user_id(), "ctx-user")

    def test_session_defaults_to_graph(self):
        host = _Host(memory_session_id="", graph=type("G", (), {"session_id": "sess"})())
        self.assertEqual(host._resolve_session_id(), "sess")

    def test_build_scope_uses_resolved_values(self):
        # namespace is intentionally NOT plumbed in Phase 1, even if present on the host.
        host = _Host(memory_user_id="u", memory_session_id="s", namespace="n")
        self.assertEqual(host._build_scope(), {"user": "u", "thread": "s"})

    def test_build_scope_user_only_when_session_excluded(self):
        host = _Host(memory_user_id="u", memory_session_id="s")
        self.assertEqual(host._build_scope(include_session=False), {"user": "u"})


if __name__ == "__main__":
    unittest.main()
