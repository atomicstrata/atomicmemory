import unittest
from types import SimpleNamespace

from atomicmemory_langflow._messages import coerce_text, memory_to_lc_message, sender_to_role


class _JsonStr:
    """Mimics a Langflow Message: has .text, but str() returns JSON (not the text)."""

    def __init__(self, text):
        self.text = text

    def __str__(self):
        return '{"text": "%s", "files": []}' % self.text


class TestCoerceText(unittest.TestCase):
    def test_extracts_text_from_message_like(self):
        # str() would give the JSON blob; coerce_text must return the .text.
        self.assertEqual(coerce_text(_JsonStr("find my prefs")), "find my prefs")

    def test_plain_string_and_none(self):
        self.assertEqual(coerce_text("hello"), "hello")
        self.assertEqual(coerce_text(None), "")


class TestSenderToRole(unittest.TestCase):
    def test_langflow_and_langchain_vocab(self):
        cases = {
            "User": "user", "human": "user", "user": "user",
            "Machine": "assistant", "ai": "assistant", "assistant": "assistant",
            "System": "system", "system": "system",
            "Tool": "tool", "tool": "tool",
        }
        for sender, role in cases.items():
            self.assertEqual(sender_to_role(sender), role, sender)

    def test_unknown_defaults_to_user(self):
        self.assertEqual(sender_to_role("anything-else"), "user")
        self.assertEqual(sender_to_role(None), "user")


class TestMemoryToLCMessage(unittest.TestCase):
    def _mem(self, content, role=None):
        meta = {"role": role} if role else None
        return SimpleNamespace(content=content, metadata=meta)

    def test_assistant_role_becomes_ai_message(self):
        msg = memory_to_lc_message(self._mem("hi", role="assistant"))
        self.assertEqual(msg.type, "ai")
        self.assertEqual(msg.content, "hi")

    def test_other_roles_never_become_system(self):
        # Retrieved memory is user-influenced; must not gain system authority.
        for role in (None, "user", "system", "tool"):
            msg = memory_to_lc_message(self._mem("x", role=role))
            self.assertNotEqual(msg.type, "system")
            self.assertEqual(msg.type, "human")


if __name__ == "__main__":
    unittest.main()
