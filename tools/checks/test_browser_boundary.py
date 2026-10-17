#!/usr/bin/env python3
"""The published recorder gate must refuse private backend or provider seam files."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / "scripts/check-browser-recorder.mjs"
PIN = (ROOT / "browser/.nvmrc").read_text().strip().removeprefix("v")
NODE = Path.home() / ".nvm/versions/node" / ("v" + PIN) / "bin/node"

class BrowserBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        (self.root / "browser/test").mkdir(parents=True)
        shutil.copyfile(SELECTOR, self.root / "scripts/check-browser-recorder.mjs")
        (self.root / "browser/test/published.test.mjs").write_text("// Generated list-only fixture\n")

    def tearDown(self):
        self.temp.cleanup()

    def run_selector(self):
        return subprocess.run([str(NODE), "scripts/check-browser-recorder.mjs", "--list"], cwd=self.root,
                              capture_output=True, text=True, timeout=5)

    def test_shared_module_is_listed_without_running_it(self):
        result = self.run_selector()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["files"]), 1)

    def test_private_backend_directory_refuses_the_public_gate(self):
        (self.root / "browser-worker").mkdir()
        result = self.run_selector()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Private hosted-service source", result.stderr)

    def test_provider_seam_file_refuses_the_public_gate(self):
        (self.root / "browser/test/ui-service.test.mjs").write_text("// Generated private seam marker\n")
        result = self.run_selector()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Private hosted-service source", result.stderr)

    def test_ci_artifacts_include_generated_evidence_without_browser_profiles(self):
        import fnmatch
        workflow = (ROOT / ".github/workflows/browser-recorder.yml").read_text().splitlines()
        patterns = []
        for index, line in enumerate(workflow):
            if line.strip() != "path: |":
                continue
            indent = len(line) - len(line.lstrip())
            for entry in workflow[index + 1:]:
                if entry.strip() and len(entry) - len(entry.lstrip()) <= indent:
                    break
                value = entry.strip()
                if value:
                    prefix = "${{ runner.temp }}/"
                    self.assertTrue(value.startswith(prefix), value)
                    patterns.append(value[len(prefix):])
        self.assertTrue(patterns)
        def matches(path, pattern):
            names, parts = path.split("/"), pattern.split("/")
            def walk(left, right):
                if not right:
                    return not left
                if right[0] == "**":
                    return walk(left, right[1:]) or bool(left) and walk(left[1:], right)
                return bool(left) and fnmatch.fnmatchcase(left[0], right[0]) and walk(left[1:], right[1:])
            return walk(names, parts)
        for path in ["rushes-browser-proof/metrics.json", "rushes-browser-proof/witness-stop.log",
                     "rushes-browser-proof/capture-cold-camera.webm", "rushes-browser-proof/normal-stop/screen.webm",
                     "rushes-independent-native-reference/supplied-reference.f32le", "rushes-browser-cold-trace/trace.json"]:
            self.assertTrue(any(matches(path, pattern) for pattern in patterns), path)
        for path in ["rushes-browser-proof/isolated-chrome-profile/Default/IndexedDB/000003.log",
                     "rushes-browser-proof/isolated-chrome-profile/Default/FileSystem/master.webm",
                     "rushes-browser-reference/isolated-chrome-profile/Default/000003.log",
                     "rushes-browser-maximum/isolated-chrome-profile/Default/master.webm",
                     "rushes-browser-proof/timecoded.mjpeg", "rushes-browser-proof/timecoded.y4m",
                     "rushes-browser-proof/calibration.wav"]:
            self.assertFalse(any(matches(path, pattern) for pattern in patterns), path)

if __name__ == "__main__":
    unittest.main()
