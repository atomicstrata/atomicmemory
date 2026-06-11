"""Test doubles for the AtomicMemory SDK client and bridge."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any


class FakeClient:
    """Records dict requests and returns canned SDK-shaped responses."""

    def __init__(self, *, list_pages=None, capabilities=None, ingest_result=None):
        self.calls: list[tuple[str, Any]] = []
        self.initialized = False
        self.closed = False
        self._list_pages = list(list_pages or [])
        self._capabilities = capabilities
        self._ingest_result = ingest_result or SimpleNamespace(
            created=["m1"], updated=[], unchanged=[]
        )
        self.deleted: list[dict] = []

    def initialize(self):
        self.initialized = True

    def close(self):
        self.closed = True

    def capabilities(self, provider_name=None):
        self.calls.append(("capabilities", provider_name))
        return self._capabilities

    def ingest(self, req):
        self.calls.append(("ingest", req))
        return self._ingest_result

    def search(self, req):
        self.calls.append(("search", req))
        return SimpleNamespace(results=[])

    def package(self, req):
        self.calls.append(("package", req))
        return SimpleNamespace(text="PACKAGED", results=[], tokens=3, budget_constrained=False)

    def list(self, req):
        self.calls.append(("list", req))
        return self._list_pages.pop(0) if self._list_pages else SimpleNamespace(
            memories=[], cursor=None
        )

    def delete(self, ref):
        self.calls.append(("delete", ref))
        self.deleted.append(ref)


def fake_factory(client: "FakeClient"):
    def factory(providers, default_provider):
        client.providers = providers
        client.default_provider = default_provider
        return client

    return factory


class FakeBridge:
    """Drop-in for AtomicMemoryBridge used by component tests."""

    def __init__(self, *, list_memories=None, capabilities=None, package_text="PKG", ingest_result=None):
        self.calls: list[tuple[str, dict]] = []
        self._memories = list_memories or []
        self._capabilities = capabilities
        self._package_text = package_text
        self._ingest_result = ingest_result or SimpleNamespace(
            created=["m1"], updated=[], unchanged=[]
        )
        self.fail_list = False

    def capabilities(self):
        self.calls.append(("capabilities", {}))
        return self._capabilities

    def list_memories(self, *, scope, limit):
        self.calls.append(("list_memories", {"scope": scope, "limit": limit}))
        if self.fail_list:
            raise RuntimeError("backend down")
        return SimpleNamespace(memories=list(self._memories), cursor=None)

    def search(self, *, scope, query, limit):
        self.calls.append(("search", {"scope": scope, "query": query, "limit": limit}))
        return SimpleNamespace(results=[])

    def package(self, *, scope, query, limit, token_budget=None):
        self.calls.append(("package", {"scope": scope, "query": query, "limit": limit}))
        return SimpleNamespace(text=self._package_text, results=[], tokens=1, budget_constrained=False)

    def ingest_messages(self, *, scope, messages, metadata=None, content_class="summary"):
        self.calls.append(
            ("ingest_messages", {"scope": scope, "messages": messages, "metadata": metadata, "content_class": content_class})
        )
        return self._ingest_result

    def delete_scope(self, *, scope):
        self.calls.append(("delete_scope", {"scope": scope}))
        return {"deleted": 2, "failed": 0, "found": 2}
