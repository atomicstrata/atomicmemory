"""Regression: package must import under the installed Hermes path.

Hermes loads user-installed memory provider plugins from
`$HERMES_HOME/plugins/<name>/`. After install, the directory is named
`atomicmemory/` — not `plugins/hermes/` — so any
`from plugins.hermes.<x> import ...` import will fail with ModuleNotFoundError.
All in-package imports must be relative.

This test simulates the installed layout by copying every shipped file into a
temp dir named `atomicmemory/`, then loading it as a package via importlib.
If anything imports `plugins.hermes.*` at module load time, it fails here.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def _shipped_files() -> list[str]:
    """Read the file list package.json declares as the published surface."""
    pkg = json.loads((PLUGIN_ROOT / "package.json").read_text(encoding="utf-8"))
    files = pkg.get("files") or []
    return [f for f in files if f.endswith(".py")]


def _provider_install_files() -> list[str]:
    """Return package files the npm installer should copy into Hermes."""
    pkg = json.loads((PLUGIN_ROOT / "package.json").read_text(encoding="utf-8"))
    files = pkg.get("files") or []
    return [f for f in files if f.endswith(".py") or f in {"plugin.yaml", "README.md"}]


class InstallPathImportsResolve(unittest.TestCase):
    def test_install_mjs_copies_provider_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "atomicmemory"
            result = subprocess.run(
                ["node", str(PLUGIN_ROOT / "install.mjs"), "install", "--target", str(target)],
                capture_output=True,
                check=True,
                text=True,
            )

            self.assertIn(f"Installed AtomicMemory Hermes provider to {target}", result.stdout)
            for name in _provider_install_files():
                self.assertTrue((target / name).exists(), f"{name} was not installed")
            self.assertFalse((target / "install.mjs").exists())
            self.assertFalse((target / "pyproject.toml").exists())

    def test_install_mjs_default_target_matches_hermes_discovery(self) -> None:
        # Hermes scans `$HERMES_HOME/plugins/<name>/` for user-installed memory
        # providers (see hermes-agent/plugins/memory/__init__.py). Installing one
        # level deeper (e.g. plugins/memory/atomicmemory/) hides the provider
        # from `hermes memory setup`.
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                ["node", str(PLUGIN_ROOT / "install.mjs"), "install"],
                capture_output=True,
                check=True,
                text=True,
                env={"HERMES_HOME": tmp, "PATH": __import__("os").environ.get("PATH", "")},
            )
            expected = Path(tmp) / "plugins" / "atomicmemory"
            self.assertIn(f"Installed AtomicMemory Hermes provider to {expected}", result.stdout)
            self.assertTrue((expected / "__init__.py").exists())
            self.assertFalse((Path(tmp) / "plugins" / "memory").exists(),
                             "installer must not nest under plugins/memory/")

    def test_pyproject_declares_hermes_entry_point(self) -> None:
        pyproject = (PLUGIN_ROOT / "pyproject.toml").read_text(encoding="utf-8")

        self.assertRegex(pyproject, r'(?m)^name\s*=\s*"atomicmemory-hermes"$')
        self.assertRegex(pyproject, r'(?m)^atomicmemory\s*=\s*"atomicmemory_hermes:register"$')
        self.assertRegex(pyproject, r'(?m)^atomicmemory_hermes\s*=\s*"\."$')

    def test_package_loads_when_directory_is_renamed_to_atomicmemory(self) -> None:
        shipped = _shipped_files()
        self.assertIn("__init__.py", shipped, "package.json must ship __init__.py")
        self.assertIn("tools.py", shipped, "package.json must ship tools.py")

        with tempfile.TemporaryDirectory() as tmp:
            install_root = Path(tmp) / "memory_plugins"
            pkg_dir = install_root / "atomicmemory"
            pkg_dir.mkdir(parents=True)
            for name in shipped:
                shutil.copy(PLUGIN_ROOT / name, pkg_dir / name)

            # Add the parent so `import atomicmemory` resolves to our copy.
            sys.path.insert(0, str(install_root))
            # Wipe any prior import of `atomicmemory` from this process.
            for mod in list(sys.modules):
                if mod == "atomicmemory" or mod.startswith("atomicmemory."):
                    del sys.modules[mod]
            try:
                installed = importlib.import_module("atomicmemory")
                # Symbols the provider class needs; absence means a relative
                # import inside the package failed under the install layout.
                self.assertTrue(hasattr(installed, "AtomicMemoryMemoryProvider"))
                self.assertTrue(hasattr(installed, "register"))
                # Submodules must also load relatively.
                tools_mod = importlib.import_module("atomicmemory.tools")
                self.assertTrue(hasattr(tools_mod, "TOOL_HANDLERS"))
                sdk_mod = importlib.import_module("atomicmemory.python_sdk")
                self.assertTrue(hasattr(sdk_mod, "PythonSdkAtomicMemoryClient"))
            finally:
                sys.path.remove(str(install_root))
                for mod in list(sys.modules):
                    if mod == "atomicmemory" or mod.startswith("atomicmemory."):
                        del sys.modules[mod]

    def test_package_loads_via_python_distribution_name(self) -> None:
        shipped = _shipped_files()

        with tempfile.TemporaryDirectory() as tmp:
            install_root = Path(tmp) / "site-packages"
            pkg_dir = install_root / "atomicmemory_hermes"
            pkg_dir.mkdir(parents=True)
            for name in shipped:
                shutil.copy(PLUGIN_ROOT / name, pkg_dir / name)

            sys.path.insert(0, str(install_root))
            for mod in list(sys.modules):
                if mod == "atomicmemory_hermes" or mod.startswith("atomicmemory_hermes."):
                    del sys.modules[mod]
            try:
                installed = importlib.import_module("atomicmemory_hermes")
                self.assertTrue(hasattr(installed, "AtomicMemoryMemoryProvider"))
                self.assertTrue(hasattr(installed, "register"))
                tools_mod = importlib.import_module("atomicmemory_hermes.tools")
                self.assertTrue(hasattr(tools_mod, "TOOL_HANDLERS"))
            finally:
                sys.path.remove(str(install_root))
                for mod in list(sys.modules):
                    if mod == "atomicmemory_hermes" or mod.startswith("atomicmemory_hermes."):
                        del sys.modules[mod]


if __name__ == "__main__":
    unittest.main()
