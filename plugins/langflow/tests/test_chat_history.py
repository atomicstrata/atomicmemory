import unittest
from types import SimpleNamespace

from atomicmemory_langflow._chat_history import AtomicMemoryChatMessageHistory
from tests.fakes import FakeBridge


def _mem(content, role=None):
    return SimpleNamespace(content=content, metadata=({"role": role} if role else None))


class TestChatHistory(unittest.TestCase):
    def test_messages_reversed_to_chronological(self):
        # Core returns newest-first; history must be oldest-first.
        bridge = FakeBridge(list_memories=[_mem("newest"), _mem("oldest")])
        hist = AtomicMemoryChatMessageHistory(bridge=bridge, scope={"user": "u"}, limit=10)
        contents = [m.content for m in hist.messages]
        self.assertEqual(contents, ["[memory] oldest", "[memory] newest"])
        self.assertEqual(bridge.calls[0], ("list_memories", {"scope": {"user": "u"}, "limit": 10}))

    def test_read_failure_raises_by_default(self):
        # Fail closed: surface "memory unavailable" rather than silent empty history.
        bridge = FakeBridge()
        bridge.fail_list = True
        hist = AtomicMemoryChatMessageHistory(bridge=bridge, scope={"user": "u"}, limit=10)
        with self.assertRaises(RuntimeError):
            _ = hist.messages

    def test_read_failure_returns_empty_when_fail_open(self):
        bridge = FakeBridge()
        bridge.fail_list = True
        hist = AtomicMemoryChatMessageHistory(
            bridge=bridge, scope={"user": "u"}, limit=10, fail_open=True
        )
        self.assertEqual(hist.messages, [])

    def test_add_messages_is_noop(self):
        bridge = FakeBridge()
        hist = AtomicMemoryChatMessageHistory(bridge=bridge, scope={"user": "u"}, limit=10)
        hist.add_messages(["anything"])  # must not raise, must not call the bridge
        self.assertEqual([c for c in bridge.calls if c[0] != "list_memories"], [])


if __name__ == "__main__":
    unittest.main()
