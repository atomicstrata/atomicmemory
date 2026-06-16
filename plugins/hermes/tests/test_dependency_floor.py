"""Hermes' two install manifests must agree on the atomicmemory floor.

Hermes can be installed two ways — `pip install` from ``pyproject.toml`` and
the host's plugin loader from ``plugin.yaml`` (see README). If those two
declare different ``atomicmemory`` minimums, one install path can silently
resolve a Python SDK that predates a security fix. This pins them together
and enforces the SSRF-fix floor (`atomicmemory>=1.1.2`, AGNT-PY-001), so a
future bump to one manifest that forgets the other fails CI.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

_HERMES_DIR = Path(__file__).resolve().parents[1]
_FLOOR_RE = re.compile(r"atomicmemory>=(\d+\.\d+\.\d+)")
_MIN_SSRF_FIX_FLOOR = (1, 1, 2)


def _extract_floor(manifest: str) -> tuple[int, int, int]:
    """Return the ``atomicmemory>=X.Y.Z`` floor declared in a manifest file."""
    text = (_HERMES_DIR / manifest).read_text(encoding="utf-8")
    match = _FLOOR_RE.search(text)
    if match is None:
        raise AssertionError(f"no atomicmemory floor found in {manifest}")
    major, minor, patch = (int(part) for part in match.group(1).split("."))
    return (major, minor, patch)


class DependencyFloorAgreement(unittest.TestCase):
    def test_plugin_yaml_and_pyproject_agree(self) -> None:
        self.assertEqual(_extract_floor("plugin.yaml"), _extract_floor("pyproject.toml"))

    def test_floor_includes_ssrf_fix(self) -> None:
        self.assertGreaterEqual(_extract_floor("pyproject.toml"), _MIN_SSRF_FIX_FLOOR)


if __name__ == "__main__":
    unittest.main()
