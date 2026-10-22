#!/usr/bin/env python3
"""Real-time generated four-track endurance. Never opens physical capture.

Every run owns its engine, socket and recordings. Short runs qualify the runner
only; a thirty-minute claim requires actual minute5/minute30 samples. Native
source/binary/probe identity and all failed evidence survive outside Git.
"""
from pathlib import Path

import argparse
import ctypes
import hashlib
import json
import math
import os
import platform, shutil, subprocess, sys, time, traceback

from process_contracts import Engine, Runner

ROLES = {"screen", "camera", "mic", "system"}
START = {"display": "main", "camera": "default", "mic": "default", "systemAudio": True, "countdownSeconds": 0}


class RUsageV0(ctypes.Structure):
    # macOS SDK sys/resource.h rusage_info_v0; this is physical footprint,
    # not ps RSS. An invalid/unavailable read fails the run.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user", "system", "idle", "interrupts", "pageins", "wired", "resident", "footprint", "start", "exit")]


def footprint(pid):
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    call = library.proc_pid_rusage
    call.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    call.restype = ctypes.c_int
    info = RUsageV0()
    if call(pid, 0, ctypes.byref(info)) != 0:
        raise OSError(ctypes.get_errno(), "proc_pid_rusage failed")
    assert info.footprint > 0, "physical footprint was zero"
    return info.footprint


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def media_check(manifest, decoded):
    assert manifest["status"] in ("complete", "recovered"), manifest["status"]
    tracks = manifest["tracks"]
    assert {t["role"] for t in tracks if t["present"]} == ROLES, tracks
    duration = manifest["clock"]["durationNs"] / 1e9
    assert math.isfinite(duration) and duration > 0
    assert len(decoded) == 4 and all(d["ok"] for d in decoded), decoded
    expected = {t["file"] for t in tracks}
    assert {Path(d["path"]).name for d in decoded} == expected
    by_file = {track["file"]: track for track in tracks}
    recovered = manifest["status"] == "recovered" and any(
        warning.get("code") == "recovered-track-timing" for warning in manifest.get("warnings", []))
    actual_ends = {}
    for item in decoded:
        declared = by_file[Path(item["path"]).name]
        assert declared.get("offsetNs", 0) == 0
        expected_duration = duration
        if recovered:
            value = declared.get("durationNs")
            assert isinstance(value, int) and not isinstance(value, bool) and value > 0, declared
            expected_duration = value / 1e9
        # Normal finished recordings retain the original 50ms COMMON duration
        # assertion. Recovered raw fragments instead declare measured tails.
        assert abs(item["duration"] - expected_duration) <= .05, item
        assert len(item["decodedTracks"]) == 1
        track = item["decodedTracks"][0]
        assert track["type"] == ("vide" if declared["role"] in ("screen", "camera") else "soun"), track
        assert track["samples"] > 0 and abs(track["firstPTS"]) <= .05, track
        assert track["maximumGap"] <= .05, track
        assert abs(track["sampleEnd"] - expected_duration) <= .05, track
        actual_ends[declared["role"]] = track["sampleEnd"]
    recovery = None
    if recovered:
        lost_camera = any(warning.get("code") == "camera-lost" for warning in manifest.get("warnings", []))
        exclude_camera = lost_camera and any(end > actual_ends["camera"] for role, end in actual_ends.items() if role != "camera")
        eligible = [end for role, end in actual_ends.items() if not (role == "camera" and exclude_camera)]
        actual_overlap = min(eligible)
        # Directly compare actual decoded bounds, never two tolerances chained
        # through producer metadata. Extra raw footage is retained, not retimed.
        assert abs(duration - actual_overlap) <= .05, (duration, actual_ends)
        recovery = {"actualCommonEndSeconds": actual_overlap, "lostCameraExcluded": exclude_camera,
                    "rawTailSeconds": {role: end - duration for role, end in actual_ends.items()},
                    "warnings": manifest.get("warnings", [])}
    return {"seconds": duration, "tracks": decoded, "recovery": recovery}


def drop_check(tracks):
    assert len(tracks) == 4, tracks
    screen = next(t for t in tracks if t["kind"] == "screen")
    written, dropped = screen["framesWritten"], screen["framesDropped"]
    assert written > 0 and dropped >= 0
    fraction = dropped / (written + dropped)
    assert fraction <= .01, {"screenDropFraction": fraction, "screen": screen}
    assert all(not t.get("errorDescription") for t in tracks), tracks
    return fraction


def memory_check(samples):
    early = min(samples, key=lambda sample: abs(sample["seconds"] - 300))
    late = min(samples, key=lambda sample: abs(sample["seconds"] - 1800))
    assert abs(early["seconds"] - 300) < 5 and abs(late["seconds"] - 1800) < 5
    growth = late["physicalFootprintBytes"] - early["physicalFootprintBytes"]
    assert growth <= 50 * 1024 * 1024, {"footprintGrowthBytes": growth}
    return {"minute5": early, "minute30": late, "growthBytes": growth}


class Endurance(Runner):
    def __init__(self, args):
        # Refuse reuse instead of silently replacing prior evidence or footage.
        assert not args.evidence_root.exists(), "Use a new evidence root"
        args.evidence_dir = args.evidence_root
        super().__init__(args)
        os.chmod(self.evidence, 0o700)
        self.duration = args.duration
        self.ffmpeg = shutil.which("ffmpeg")
        assert self.ffmpeg, "ffmpeg is required for an independent tail seek"

    def identity(self):
        source = hashlib.sha256()
        for path in sorted((self.repo / "Sources").rglob("*.swift")):
            source.update(str(path.relative_to(self.repo)).encode()); source.update(path.read_bytes())
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=self.repo, text=True)
        result = {"revision": revision, "dirtyPaths": dirty.splitlines(), "nativeSourceDigest": source.hexdigest(),
                  "engineSHA256": digest(self.engine), "cliSHA256": digest(self.cli),
                  "probeSourceSHA256": digest(self.repo / "verification/ProbeMedia.swift"),
                  "runnerSHA256": digest(__file__), "platform": platform.platform(),
                  "physicalCapture": False, "durationRequested": self.duration}
        (self.evidence / "identity.json").write_text(json.dumps(result, indent=2))
        return result

    def memory_control(self):
        before = footprint(os.getpid())
        owned = bytearray(24 * 1024 * 1024)
        owned[::4096] = b"x" * len(owned[::4096])
        after = footprint(os.getpid())
        assert after - before >= 8 * 1024 * 1024, (before, after)
        result = {"instrument": "proc_pid_rusage/RUSAGE_INFO_V0/ri_phys_footprint", "before": before, "afterTouching24MiB": after}
        del owned
        (self.evidence / "memory-positive-control.json").write_text(json.dumps(result, indent=2))

    def decode_all(self, package, destination):
        manifest = json.loads((package / "manifest.json").read_text())
        paths = [package / track["file"] for track in manifest["tracks"] if track["present"]]
        result = self.command([str(self.probe), *map(str, paths)], destination / "decode.json", timeout=600)
        assert result["exit"] == 0, result
        decoded = json.loads(result["stdout"])
        details = media_check(manifest, decoded)
        for index, item in enumerate(decoded):
            # Input seeking plus positive output progress distinguishes a real
            # playable tail from a successful command that produced no samples.
            tail = self.command([self.ffmpeg, "-nostdin", "-v", "error", "-ss", str(max(0, item["duration"] - .75)),
                "-i", item["path"], "-t", "0.5", "-map", "0:0", "-progress", "pipe:1", "-f", "null", "-"],
                destination / f"tail-{index}.json", timeout=60)
            assert tail["exit"] == 0, tail
            progress = [int(line.split("=", 1)[1]) for line in tail["stdout"].splitlines() if line.startswith("out_time_us=")]
            assert progress and max(progress) >= 250_000, tail
        return details

    def take(self, name, duration, pauses):
        samples, transitions = [], []
        with Engine(self, name) as engine:
            (engine.base / "owned-process.json").write_text(json.dumps({"pid": engine.process.pid, "argv": engine.argv, "physicalCapture": False}, indent=2))
            started = engine.request("record.start", START)
            assert started["ok"], started
            package = Path(started["result"]["packagePath"])
            start = time.monotonic(); wall_start = time.time()
            interval = min(60, duration / 6)
            next_sample = interval
            next_pause = 0
            pause_at = [duration * value for value in (.07, .23, .39, .57, .73)][:pauses]
            pause_length = min(2, duration / 60)
            while True:
                elapsed = time.monotonic() - start
                assert abs((time.time() - wall_start) - elapsed) < 5, "Host sleep/clock change invalidated wall-time measurement"
                if next_pause < len(pause_at) and elapsed >= pause_at[next_pause]:
                    assert engine.request("record.pause")["ok"]
                    before = engine.request("status")["result"]["recording"]["elapsedMediaNs"]
                    time.sleep(pause_length)
                    after = engine.request("status")["result"]["recording"]["elapsedMediaNs"]
                    assert before == after, "media time advanced during pause"
                    assert engine.request("record.resume")["ok"]
                    transitions.append({"pausedAtSeconds": elapsed, "wallSeconds": pause_length, "mediaNs": before})
                    next_pause += 1
                    continue
                if elapsed >= next_sample or elapsed >= duration:
                    status = engine.request("status")["result"]
                    assert status["state"] == "recording", status
                    sample = {"seconds": elapsed, "physicalFootprintBytes": footprint(engine.process.pid),
                              "loadAverage": os.getloadavg(), "recording": status["recording"]}
                    samples.append(sample)
                    with (engine.base / "samples.jsonl").open("a") as stream: stream.write(json.dumps(sample) + "\n")
                    print(json.dumps({"take": name, "seconds": round(elapsed, 2), "footprintMiB": round(sample["physicalFootprintBytes"] / 2**20, 2)}), flush=True)
                    next_sample += interval
                if elapsed >= duration: break
                time.sleep(min(.2, max(.01, duration - elapsed)))
            before_stop = engine.request("status")["result"]["recording"]
            stop_start = time.monotonic()
            stopped = engine.request("record.stop", timeout=20)
            assert stopped["ok"] and stopped["result"]["status"] == "complete", stopped
            assert time.monotonic() - stop_start < 10, "normal generated Stop exceeded total expectation"
            assert engine.request("status")["result"]["state"] == "idle"
            manifest = json.loads((package / "manifest.json").read_text())
            actual = manifest["clock"]["durationNs"] / 1e9
            wall_elapsed = stop_start - start
            stop_seconds = time.monotonic() - stop_start
            paused = sum((end - begin) / 1e9 for begin, end in manifest["clock"]["pausesNs"])
            assert abs(actual + paused - wall_elapsed) < .5, (actual, paused, wall_elapsed)
            memory = memory_check(samples) if duration >= 1800 else {"qualifiedThirtyMinutes": False}
        media = self.decode_all(package, engine.base)
        drop_fraction = drop_check(before_stop["tracks"])
        screen = next(track for track in before_stop["tracks"] if track["kind"] == "screen")
        final_drops = next(track for track in manifest["tracks"] if track["role"] == "screen")["droppedFrames"]
        # Final counters include a bounded pending tail. Using the pre-Stop
        # written count makes this conservative instead of hiding tail loss.
        final_drop_fraction = final_drops / (screen["framesWritten"] + final_drops)
        assert final_drop_fraction <= .01, {"finalScreenDropFraction": final_drop_fraction}
        return {"package": str(package), "wallSeconds": wall_elapsed, "stopSeconds": stop_seconds, "pauseChecks": transitions,
                "screenDropFraction": drop_fraction, "finalScreenDropFraction": final_drop_fraction, "memory": memory, "media": media}

    def crash(self):
        engine = Engine(self, "kill-owned-take")
        try:
            start = engine.request("record.start", START)
            assert start["ok"], start
            package = Path(start["result"]["packagePath"])
            capture_start = time.monotonic()
            time.sleep(4.3)
            kill_elapsed = time.monotonic() - capture_start
        finally:
            engine.close(kill=True)
        hashes = {path.name: digest(path) for path in package.glob("*.mov")}
        assert len(hashes) == 4, hashes
        (engine.base / "original-hashes.json").write_text(json.dumps(hashes, indent=2))
        with Engine(self, "restart-owned-take", engine.root) as restarted:
            deadline = time.monotonic() + 20
            while True:
                shown = restarted.request("show", {"id": start["result"]["id"]})
                assert shown["ok"], shown
                if shown["result"]["manifest"]["status"] == "recovered": break
                assert time.monotonic() < deadline, shown
                time.sleep(.1)
            assert hashes == {name: digest(package / name) for name in hashes}, "Recovery changed or removed original bytes"
        media = self.decode_all(package, restarted.base)
        assert media["seconds"] >= kill_elapsed - 1.05, "crash lost more than the open fragment budget"
        return {"originalHashesUnchanged": True, "killWallSeconds": kill_elapsed,
                "lostTailSeconds": kill_elapsed - media["seconds"], "media": media}

    def run(self):
        identity = self.identity()
        build = self.command(["swiftc", "-parse-as-library", str(self.repo / "verification/ProbeMedia.swift"), "-o", str(self.probe)], self.evidence / "probe-build.json", timeout=90)
        assert build["exit"] == 0, build
        self.memory_control()
        self.check("real-time-four-track", lambda: self.take("endurance-take", self.duration, 5))
        if self.results[-1]["status"] == "verified":
            for index in range(3): self.check(f"repeat-{index}", lambda index=index: self.take(f"repeat-{index}", 3, 0))
            self.check("kill-recovery-originals", self.crash)
        passed = all(result["status"] == "verified" for result in self.results)
        report = {"status": "verified" if passed else "failed", "identity": identity, "results": self.results,
                  "thirtyMinuteEndurance": passed and self.duration >= 1800,
                  "coverage": "Generated NV12/zero PCM on host clock; real native encoders/files. No physical input, speech, or A/V sync calibration."}
        (self.evidence / "report.json").write_text(json.dumps(report, indent=2))
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--duration", type=float, default=1800)
    parser.add_argument("--evidence-root", type=Path, required=True)
    args = parser.parse_args()
    if sys.flags.optimize: parser.error("Assertions must remain enabled")
    if not math.isfinite(args.duration) or not 3 <= args.duration <= 21600: parser.error("duration must be finite, 3..21600 seconds")
    runner = Endurance(args)
    try:
        sys.exit(0 if runner.run()["status"] == "verified" else 1)
    except Exception:
        (runner.evidence / "harness-error.txt").write_text(traceback.format_exc())
        raise
