import unittest

from atomicmemory_langflow._sdk import sdk_is_available


@unittest.skipUnless(sdk_is_available(), "atomicmemory SDK not installed")
class TestRealSDKRequestTypes(unittest.TestCase):
    """Validate that the dicts our bridge builds satisfy the real SDK models."""

    def test_scope_dict_validates(self):
        from atomicmemory import Scope

        from atomicmemory_langflow._scope import build_scope

        Scope(**build_scope("u", session_id="s", namespace="n", agent_id="a"))

    def test_message_ingest_validates(self):
        from atomicmemory import MessageIngest

        from atomicmemory_langflow._scope import build_scope

        MessageIngest(
            scope=build_scope("u"),
            messages=[{"role": "user", "content": "hi"}],
            provenance={"source": "langflow"},
            metadata={"kind": "turn"},
        )

    def test_search_list_package_ref_validate(self):
        from atomicmemory import ListRequest, MemoryRef, PackageRequest, SearchRequest

        from atomicmemory_langflow._scope import build_scope

        scope = build_scope("u")
        SearchRequest(query="q", scope=scope, limit=5)
        PackageRequest(query="q", scope=scope, limit=5, token_budget=256)
        ListRequest(scope=scope, limit=10)
        MemoryRef(id="m1", scope=scope)


if __name__ == "__main__":
    unittest.main()
