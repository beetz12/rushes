#!/usr/bin/env python3
"""Independent export/edit oracle against the integrated engine socket.

Run only after the real integrated release build. Uses synthetic capture in an
owned library, every-sample AVFoundation decode, source SHA256 and MP4 box data.
Does not use maker test results as assertions or write to external services.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess

from process_contracts import Engine, Runner


def hashes(package):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in package.glob("*.mov")}


def boxes(path):
    answer = []
    size = path.stat().st_size
    with path.open("rb") as stream:
        while stream.tell() < size:
            offset = stream.tell()
            header = stream.read(8)
            assert len(header) == 8, f"torn top-level MP4 box at {offset}"
            length, kind = struct.unpack(">I4s", header)
            if length == 1:
                length = struct.unpack(">Q", stream.read(8))[0]
            elif length == 0:
                length = size - offset
            assert 8 <= length <= size - offset, (offset, kind, length, size)
            answer.append(kind.decode("ascii"))
            stream.seek(offset + length)
    return answer


class ExportRunner(Runner):
    def verified_request(self, engine, cmd, args):
        reply = engine.request(cmd, args, timeout=90)
        assert reply["ok"], reply
        return reply["result"]

    def probe_output(self, path, expected_seconds, require_video=False, fast_start=False):
        decoded = self.command([str(self.probe), str(path)], path.with_suffix(".decode.json"), timeout=60)
        assert decoded["exit"] == 0, decoded
        media = json.loads(decoded["stdout"])[0]
        assert abs(media["duration"] - expected_seconds) < .05, media
        if require_video:
            assert any(t["type"] == "vide" for t in media["decodedTracks"]), media
        if fast_start:
            order = boxes(path)
            assert order[:2] == ["ftyp", "moov"], order
        return media

    def all_exports(self):
        with Engine(self, "native-exports") as engine:
            take = engine.cli(["record", "start", "--display", "main", "--system-audio",
                               "--duration", "3", "--wait"], timeout=30)
            assert take["exit"] == 0, take
            done = [json.loads(line) for line in take["stdout"].splitlines()
                    if json.loads(line).get("event") == "done"][-1]["result"]
            assert done["status"] == "complete", done
            ident = done["id"]
            package = Path(done["packagePath"])
            before = hashes(package)
            manifest, decoded = self.decode(package)
            length = manifest["clock"]["durationNs"] / 1e9
            exports = self.evidence / "exported-media"
            exports.mkdir(exist_ok=True)
            results = {}
            for preset, container, fps in [("share", "mp4", 30), ("full", "mov", 30),
                                           ("youtube", "mp4", 60), ("audio", "m4a", 30),
                                           ("audio", "wav", 30)]:
                path = exports / f"{preset}.{container}"
                result = self.verified_request(engine, "export", {
                    "id": ident, "preset": preset, "container": container,
                    "fps": fps, "path": str(path)})
                results[path.name] = {"reply": result, "decoded": self.probe_output(
                    path, length, preset != "audio", container == "mp4")}
                assert hashes(package) == before, f"{preset} altered originals"
            cached = self.verified_request(engine, "export", {
                "id": ident, "preset": "share", "path": str(exports / "share-again.mp4")})
            assert cached["cached"], cached
            original_key = results["share.mp4"]["reply"]["cacheKey"]
            assert cached["cacheKey"] == original_key
            trimmed = self.verified_request(engine, "edit.set", {
                "id": ident, "startMs": 500, "endMs": 2500, "speed": 2,
                "title": "Independent trimmed take"})
            assert trimmed["clips"][0]["speed"] == 2
            path = exports / "trimmed.mp4"
            trimmed_export = self.verified_request(engine, "export", {
                "id": ident, "preset": "share", "path": str(path)})
            assert trimmed_export["cacheKey"] != original_key and not trimmed_export["cached"]
            results["trimmed.mp4"] = {"reply": trimmed_export,
                                      "decoded": self.probe_output(path, 1, True, True)}
            undo = self.verified_request(engine, "edit.undo", {"id": ident})
            assert undo["clips"][0]["sourceStartMs"] == 0 and undo["clips"][0]["speed"] == 1, undo
            redo = self.verified_request(engine, "edit.redo", {"id": ident})
            assert redo["clips"] == trimmed["clips"], redo
            saved = self.verified_request(engine, "edit.save", {"id": ident})
            disk = json.loads((package / "edit.json").read_text())
            assert disk["clips"] == saved["clips"] and not (package / "edit.draft.json").exists()
            handoff = exports / "editor-tracks"
            tracks = self.verified_request(engine, "export", {
                "id": ident, "preset": "editor-tracks", "path": str(handoff)})
            offsets = json.loads((handoff / "offsets.json").read_text())
            assert offsets["editApplied"] is False
            assert {row["file"] for row in offsets["tracks"]} == set(before)
            for name, digest in before.items():
                assert hashlib.sha256((handoff / name).read_bytes()).hexdigest() == digest
            # Negative controls run through exactly the same export command.
            forbidden = [package / "screen.mov", package / "manifest.json"]
            second = engine.root / "2026-10-11_independent_01KVER"
            shutil.copytree(package, second)
            second_manifest = json.loads((second / "manifest.json").read_text())
            second_manifest["id"] = "01KVEROTHERRECORDING"
            (second / "manifest.json").write_text(json.dumps(second_manifest))
            second_hashes = hashes(second)
            forbidden.append(second / "screen.mov")
            alias = exports / "aliased-master.mp4"
            alias.symlink_to(second / "screen.mov")
            forbidden.append(alias)
            for output in forbidden:
                reply = engine.request("export", {"id": ident, "preset": "share", "path": str(output)}, timeout=90)
                assert not reply["ok"], {"contract": "export cannot overwrite current or another recording's masters/metadata", "output": str(output), "reply": reply}
                assert hashes(package) == before and hashes(second) == second_hashes
            assert hashes(package) == before
        with Engine(self, "native-exports-restart", engine.root) as restarted:
            loaded = self.verified_request(restarted, "edit.get", {"id": ident})
            assert loaded["clips"] == saved["clips"] and loaded["meta"]["title"] == "Independent trimmed take"
        return {"package": str(package), "originalsUnchanged": True,
                "exports": results, "editorTracks": tracks, "restartPersistedEdit": True}

    def run_exports(self):
        build = self.command(["swiftc", "-parse-as-library", str(self.repo / "verification/ProbeMedia.swift"),
                              "-o", str(self.probe)], self.evidence / "probe-build.json", timeout=60)
        assert build["exit"] == 0, build
        self.check("native-playable-edits-and-export-original-preservation", self.all_exports)
        report = {"status": "verified" if self.results[0]["status"] == "verified" else "failed",
                  "testedRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip(),
                  "evidenceDir": str(self.evidence), "results": self.results,
                  "untested": ["real captured visuals/audio identity", "external provider hosting",
                               "live GUI walkthrough", "10-minute/60-minute performance thresholds"]}
        (self.evidence / "report.json").write_text(json.dumps(report, indent=2))
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    runner = ExportRunner(args)
    report = runner.run_exports()
    raise SystemExit(0 if report["status"] == "verified" else 1)
