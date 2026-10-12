#!/usr/bin/env python3
"""Negative controls for file provenance and distributed dependency licences."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

CHECKER = Path(__file__).with_name("check_notices.py")

class NoticesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "tools/checks").mkdir(parents=True)
        shutil.copy2(CHECKER, self.root / "tools/checks/check_notices.py")
        (self.root / "Sources").mkdir()
        (self.root / "licenses").mkdir()
        (self.root / "licenses/MIT-example.txt").write_text("Fixture permission text")
        (self.root / "Sources/Example.swift").write_text("// Derived from example/repo@sha:file (MIT). See THIRD_PARTY_NOTICES.md.\n")
        self.row = "| Sources/Example.swift | example/repo | sha | file | MIT (licenses/MIT-example.txt) | Author | None |\n"
        (self.root / "THIRD_PARTY_NOTICES.md").write_text(self.row)

    def tearDown(self):
        self.temp.cleanup()

    def result(self):
        return subprocess.run(["python3", "-I", str(self.root / "tools/checks/check_notices.py")], capture_output=True, text=True)

    def test_valid_then_missing_exact_provenance(self):
        self.assertEqual(self.result().returncode, 0)
        (self.root / "THIRD_PARTY_NOTICES.md").write_text("Example.swift mentioned in prose")
        result = self.result()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing exact provenance row", result.stderr)

    def test_notice_names_missing_file(self):
        (self.root / "Sources/Example.swift").unlink()
        result = self.result()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("notice names absent file", result.stderr)

    def test_license_text_required(self):
        (self.root / "licenses/MIT-example.txt").unlink()
        self.assertIn("full licence text missing", self.result().stderr)

    def test_dependency_version_and_license_policy(self):
        (self.root / "shell/node_modules/example").mkdir(parents=True)
        manifest = self.root / "shell/package.json"
        manifest.write_text(json.dumps({"dependencies": {"example": "1.0.0"}}))
        metadata = self.root / "shell/node_modules/example/package.json"
        metadata.write_text(json.dumps({"version": "1.0.0", "license": "MIT"}))
        text = self.root / "THIRD_PARTY_NOTICES.md"
        text.write_text(self.row + "| npm: shell/example@1.0.0 | MIT | licenses/npm-example-1.0.0.txt |\n")
        (self.root / "licenses/npm-example-1.0.0.txt").write_text("Fixture MIT permission text")
        self.assertEqual(self.result().returncode, 0)
        metadata.write_text(json.dumps({"version": "2.0.0", "license": "MIT"}))
        self.assertIn("missing pinned dependency notice", self.result().stderr)
        metadata.write_text(json.dumps({"version": "1.0.0", "license": "AGPL-3.0-only"}))
        self.assertIn("dependency license needs review", self.result().stderr)

    def test_browser_packages_cannot_ship_without_pinned_notices(self):
        for surface in ("browser", "browser-worker"):
            folder = self.root / surface / "node_modules/example"
            folder.mkdir(parents=True)
            (self.root / surface / "package.json").write_text(json.dumps({"dependencies": {"example": "1.0.0"}}))
            (folder / "package.json").write_text(json.dumps({"version": "1.0.0", "license": "MIT"}))
        error = self.result().stderr
        self.assertIn("missing pinned dependency notice: browser/example@1.0.0", error)
        self.assertIn("missing pinned dependency notice: browser-worker/example@1.0.0", error)

if __name__ == "__main__":
    unittest.main()
