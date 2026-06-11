import unittest
from unittest import mock

from atomicmemory_langflow._sdk import (
    DEFAULT_API_URL,
    AtomicMemoryBridge,
    validate_api_url,
    validate_provider,
    validate_provider_config,
)


class TestApiUrl(unittest.TestCase):
    def test_blank_url_defaults_local(self):
        self.assertEqual(validate_api_url(""), DEFAULT_API_URL)
        self.assertEqual(validate_api_url(None), DEFAULT_API_URL)

    def test_non_http_scheme_rejected(self):
        for bad in ("file:///etc/passwd", "ftp://host"):
            with self.assertRaises(ValueError):
                validate_api_url(bad)

    def test_local_urls_ok(self):
        self.assertEqual(validate_api_url("http://127.0.0.1:17350"), "http://127.0.0.1:17350")

    @mock.patch.dict("os.environ", {}, clear=True)
    def test_remote_url_rejected_by_default(self):
        # Fail closed: flow authors cannot point memory at arbitrary hosts (SSRF).
        with self.assertRaises(ValueError):
            validate_api_url("https://attacker.example/")

    @mock.patch.dict("os.environ", {"ATOMICMEMORY_LANGFLOW_ALLOW_REMOTE": "1"}, clear=True)
    def test_remote_url_allowed_when_operator_opts_in(self):
        self.assertEqual(validate_api_url("https://core.internal/"), "https://core.internal/")

    @mock.patch.dict(
        "os.environ", {"ATOMICMEMORY_LANGFLOW_ALLOWED_HOSTS": "core.internal, other"}, clear=True
    )
    def test_remote_url_allowed_via_host_allowlist(self):
        self.assertEqual(validate_api_url("https://core.internal/"), "https://core.internal/")
        with self.assertRaises(ValueError):
            validate_api_url("https://not-listed.example/")


class TestProvider(unittest.TestCase):
    def test_atomicmemory_ok_and_default(self):
        self.assertEqual(validate_provider("atomicmemory"), "atomicmemory")
        self.assertEqual(validate_provider(""), "atomicmemory")
        self.assertEqual(validate_provider(None), "atomicmemory")

    def test_unsupported_provider_rejected(self):
        for name in ("mem0", "hindsight", "anything"):
            with self.assertRaises(ValueError):
                validate_provider(name)

    @mock.patch.dict("os.environ", {}, clear=True)
    def test_bridge_rejects_unsupported_provider(self):
        with self.assertRaises(ValueError):
            AtomicMemoryBridge(provider="mem0", api_url="http://localhost:17350")


class TestProviderConfig(unittest.TestCase):
    def test_allows_known_tuning_keys(self):
        self.assertEqual(validate_provider_config({"timeoutSeconds": 5}), {"timeoutSeconds": 5})
        self.assertEqual(validate_provider_config({"timeout_seconds": 5}), {"timeout_seconds": 5})
        self.assertEqual(validate_provider_config({"apiVersion": "v1"}), {"apiVersion": "v1"})
        self.assertEqual(validate_provider_config(None), {})

    def test_rejects_secret_shaped_keys_camel_and_snake(self):
        # Allowlist catches denylist gaps: these were previously accepted.
        for key in (
            "apiKey", "api_key", "token", "password", "secret", "headers", "authorization",
            "accessToken", "refreshToken", "clientSecret", "client_secret", "bearerToken",
            "authToken", "credentialValue", "apiUrl", "api_url",
        ):
            with self.assertRaises(ValueError):
                validate_provider_config({key: "v"})

    def test_rejects_unknown_nested_structures(self):
        with self.assertRaises(ValueError):
            validate_provider_config({"nested": {"authorization": "Bearer x"}})


class TestProviderSettings(unittest.TestCase):
    @mock.patch.dict("os.environ", {}, clear=True)
    def test_validated_connection_fields_applied_last(self):
        bridge = AtomicMemoryBridge(
            provider="atomicmemory", api_url="http://localhost:17350", api_key="k",
            provider_config={"timeoutSeconds": 5},
        )
        settings = bridge._provider_settings()
        self.assertEqual(settings["apiUrl"], "http://localhost:17350")
        self.assertEqual(settings["apiKey"], "k")
        self.assertEqual(settings["timeoutSeconds"], 5)


if __name__ == "__main__":
    unittest.main()
