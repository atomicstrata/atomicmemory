import unittest

from atomicmemory_langflow._scope import build_scope


class TestBuildScope(unittest.TestCase):
    def test_user_only(self):
        self.assertEqual(build_scope("u1"), {"user": "u1"})

    def test_all_fields_mapped(self):
        scope = build_scope(
            "u1", session_id="s1", namespace="ns1", agent_id="a1"
        )
        self.assertEqual(
            scope,
            {"user": "u1", "thread": "s1", "namespace": "ns1", "agent": "a1"},
        )

    def test_blank_optionals_omitted(self):
        self.assertEqual(build_scope("u1", session_id="  ", namespace=""), {"user": "u1"})

    def test_missing_user_raises(self):
        with self.assertRaises(ValueError):
            build_scope("   ")


if __name__ == "__main__":
    unittest.main()
