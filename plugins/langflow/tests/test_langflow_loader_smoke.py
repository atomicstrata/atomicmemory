import shutil
import tempfile
import unittest
from pathlib import Path

try:
    from lfx.custom.directory_reader.utils import build_custom_component_list_from_path
    from lfx.custom.validate import extract_class_name
    from lfx.interface.components import discover_component_names

    HAS_LFX = True
except Exception:
    HAS_LFX = False


@unittest.skipUnless(HAS_LFX, "Langflow (lfx) not installed")
class TestLangflowLoaderSmoke(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.category = self.tmp / "atomicmemory"
        self.category.mkdir()
        entries = Path(__file__).resolve().parent.parent / "entries"
        for name in ("chat_memory", "search_context", "store_message", "delete"):
            shutil.copyfile(entries / f"{name}.py", self.category / f"{name}.py")

    async def asyncTearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def test_components_are_discovered(self):
        names = await discover_component_names("atomicmemory", [str(self.tmp)])
        for name in ("chat_memory", "search_context", "store_message", "delete"):
            self.assertIn(name, names)

    async def test_component_class_extracts_from_each_entry(self):
        for name in ("chat_memory", "search_context", "store_message", "delete"):
            code = (self.category / f"{name}.py").read_text()
            class_name = extract_class_name(code)  # raises if no Component-based ClassDef
            self.assertTrue(class_name)

    async def test_full_template_build_loads_all_four(self):
        # The real failure mode is template construction, not just discovery: build
        # the full component list Langflow uses and assert all four templates load.
        catalog = build_custom_component_list_from_path(str(self.tmp))
        self.assertIn("atomicmemory", catalog)
        self.assertEqual(len(catalog["atomicmemory"]), 4)
        for template in catalog["atomicmemory"].values():
            self.assertTrue(template, "component template failed to build")


if __name__ == "__main__":
    unittest.main()
