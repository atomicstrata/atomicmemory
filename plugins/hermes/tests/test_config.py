"""Config loader + scope-policy helpers."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from plugins.hermes.config import (
    DEFAULT_USER_ID,
    SOURCE_SITE,
    get_config_schema,
    ingest_scope_dict,
    load_config,
    read_scope_kwargs,
    save_config,
)


class LoadConfigPrecedence(unittest.TestCase):
    def test_env_seeds_then_file_overrides(self) -> None:
        env = {
            "ATOMICMEMORY_SCOPE_USER": "env-user",
            "ATOMICMEMORY_SCOPE_AGENT": "env-agent",
            "ATOMICMEMORY_MEMORY_SCOPE": "shared",
            "ATOMICMEMORY_SEARCH_LIMIT": "9",
        }
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "atomicmemory.json").write_text(
                json.dumps(
                    {
                        "scope_agent": "file-agent",
                        "memory_scope": "siloed",
                        "search_limit": 11,
                    },
                ),
                encoding="utf-8",
            )

            cfg = load_config(hermes_home=tmp, env=env)

        self.assertEqual(cfg.scope_user, "env-user")
        self.assertEqual(cfg.scope_agent, "file-agent")
        self.assertEqual(cfg.memory_scope, "siloed")
        self.assertEqual(cfg.search_limit, 11)


class LoadConfigDefaults(unittest.TestCase):
    def test_no_env_no_file_yields_default_user_and_shared_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(hermes_home=tmp, env={})

        self.assertEqual(cfg.scope_user, DEFAULT_USER_ID)
        self.assertEqual(cfg.memory_scope, "shared")
        self.assertEqual(cfg.memory_mode, "hybrid")


class LoadConfigInvalidEnumFallsBack(unittest.TestCase):
    def test_unknown_memory_scope_uses_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(
                hermes_home=tmp,
                env={"ATOMICMEMORY_MEMORY_SCOPE": "off-the-wall"},
            )

        self.assertEqual(cfg.memory_scope, "shared")


class ReadScopeKwargs(unittest.TestCase):
    def test_shared_omits_source_site(self) -> None:
        kwargs = read_scope_kwargs(memory_scope="shared", user_id="u1")

        self.assertEqual(kwargs, {"scope": {"user": "u1"}})

    def test_siloed_includes_source_site_hermes(self) -> None:
        kwargs = read_scope_kwargs(memory_scope="siloed", user_id="u1")

        self.assertEqual(kwargs, {"scope": {"user": "u1"}, "source_site": SOURCE_SITE})


class IngestScopeDictAlwaysUserOnly(unittest.TestCase):
    def test_no_source_site_in_scope(self) -> None:
        scope = ingest_scope_dict(user_id="u1")

        self.assertEqual(scope, {"user": "u1"})


class SaveConfigStripsUnknownKeys(unittest.TestCase):
    def test_drops_disallowed_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            save_config(
                {
                    "scope_user": "u1",
                    "memory_scope": "siloed",
                    "api_key": "should-not-persist",  # not in CONFIG_FILE_KEYS
                    "api_url": "http://nope",  # not in CONFIG_FILE_KEYS
                },
                tmp,
            )

            saved = json.loads(Path(tmp, "atomicmemory.json").read_text(encoding="utf-8"))

        self.assertEqual(saved.get("scope_user"), "u1")
        self.assertEqual(saved.get("memory_scope"), "siloed")
        self.assertNotIn("api_key", saved)
        self.assertNotIn("api_url", saved)


class SaveConfigPreservesPriorEntries(unittest.TestCase):
    def test_prior_keys_remain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "atomicmemory.json").write_text(
                json.dumps({"scope_agent": "old-agent", "memory_mode": "context"}),
                encoding="utf-8",
            )

            save_config({"memory_scope": "siloed"}, tmp)
            saved = json.loads(Path(tmp, "atomicmemory.json").read_text(encoding="utf-8"))

        self.assertEqual(saved["scope_agent"], "old-agent")
        self.assertEqual(saved["memory_mode"], "context")
        self.assertEqual(saved["memory_scope"], "siloed")


class GetConfigSchemaShapesUserPrompts(unittest.TestCase):
    def test_schema_includes_scope_user_and_memory_scope(self) -> None:
        schema = get_config_schema()
        keys = {entry["key"] for entry in schema}

        self.assertEqual(keys, {"scope_user", "memory_scope"})


if __name__ == "__main__":
    unittest.main()
