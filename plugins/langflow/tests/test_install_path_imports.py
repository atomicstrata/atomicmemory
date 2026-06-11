import unittest


class TestPackageImports(unittest.TestCase):
    def test_package_imports_without_langflow(self):
        import atomicmemory_langflow

        self.assertEqual(atomicmemory_langflow.__version__, "0.1.0")

    def test_helper_modules_import_standalone(self):
        # These must import without lfx/langflow present.
        from atomicmemory_langflow import _scope, _messages, _sdk  # noqa: F401

    def test_entry_files_define_local_component_subclass(self):
        # Langflow loads components by AST-parsing the file for a ClassDef whose
        # base name contains "Component"/"LC". A pure re-export would NOT match.
        import ast
        from pathlib import Path

        entries = Path(__file__).resolve().parent.parent / "entries"
        for name in ("chat_memory", "search_context", "store_message", "delete"):
            code = (entries / f"{name}.py").read_text()
            tree = ast.parse(code)
            class_defs = [n for n in tree.body if isinstance(n, ast.ClassDef)]
            self.assertTrue(class_defs, f"{name}.py must define a class")
            bases = [b.id for cd in class_defs for b in cd.bases if isinstance(b, ast.Name)]
            self.assertTrue(
                any("Component" in b or "LC" in b for b in bases),
                f"{name}.py base must contain 'Component'/'LC' for Langflow discovery",
            )


if __name__ == "__main__":
    unittest.main()
