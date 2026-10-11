#!/usr/bin/env python3
"""Coverage of the clean-room verifier's actual input enumeration."""
import tempfile
import unittest
from pathlib import Path
import check_clean

class CleanInputsTests(unittest.TestCase):
    def test_source_directory_includes_sources_not_generated_stores(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wanted = [root / "Capture.swift", root / "client.ts", root / "app.tsx", root / "schema.json"]
            excluded = [root / "node_modules/lib/index.ts", root / "dist/app.js", root / "package-lock.json"]
            for file in wanted + excluded:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("const original = true")
            self.assertEqual(set(check_clean.doc_files([root])), set(wanted))

    def test_explicit_source_file_remains_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "Capture.swift"
            file.write_text("original source")
            self.assertEqual(list(check_clean.doc_files([file])), [file])

    def test_missing_input_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                list(check_clean.doc_files([Path(directory) / "missing.swift"]))

if __name__ == "__main__":
    unittest.main()
