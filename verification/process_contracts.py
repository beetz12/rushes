#!/usr/bin/env python3
"""Exercise shipped engine/CLI behavior in owned temporary roots, with no capture.

This independent oracle never imports maker tests, touches the user library,
opens reference repositories, launches real capture, or changes global clipboard.
All commands, actual return codes, replies, fixtures and failure logs survive in
--evidence-dir. A nonzero exit means a contract was disproved, not build failure.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import traceback


class Engine:
    def __init__(self, runner, name, root=None):
        self.runner, self.name = runner, name
        self.base = runner.evidence / name
        self.base.mkdir(parents=True, exist_ok=True)
        self.root = root or self.base / "recordings"
        self.root.mkdir(exist_ok=True)
        self.socket_dir = Path(tempfile.mkdtemp(prefix="rver-", dir="/tmp"))
        self.socket = self.socket_dir / "c.sock"
        self.logs = [(self.base / "engine.stdout").open("wb"),
                     (self.base / "engine.stderr").open("wb")]
        self.argv = [str(runner.engine), "--capture-stub", "--socket-path", str(self.socket),
                     "--recordings-root", str(self.root), "--index-path", str(self.base / "index.sqlite")]
        self.process = subprocess.Popen(self.argv, stdout=self.logs[0], stderr=self.logs[1])
        self.events = []
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f"engine startup exit={self.process.returncode}; {self.base}")
            if self.socket.exists():
                try:
                    self.request("ping")
                    time.sleep(.1)  # launch recovery/index task starts before fixtures are queried
                    return
                except (OSError, TimeoutError):
                    pass
            time.sleep(.03)
        raise AssertionError(f"engine never opened socket; {self.base}")

    def request(self, cmd, args=None, timeout=10):
        tag = f"verifier-{time.monotonic_ns()}"
        req = {"id": tag, "cmd": cmd, "args": args or {}}
        transcript = {"request": req, "events": []}
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
                conn.settimeout(timeout)
                conn.connect(str(self.socket))
                conn.sendall(json.dumps(req).encode() + b"\n")
                with conn.makefile("rb") as stream:
                    while True:
                        line = stream.readline()
                        if not line:
                            raise EOFError(f"engine closed connection; process exit={self.process.poll()}")
                        reply = json.loads(line)
                        transcript["events"].append(reply)
                        if reply.get("id") == tag and "ok" in reply:
                            return reply
        finally:
            self.events.append(transcript)

    def cli(self, args, timeout=20):
        return self.runner.command([str(self.runner.cli), "--socket", str(self.socket), *args],
                                   self.base / f"cli-{len(self.events)}.json", timeout=timeout)

    def close(self, kill=False):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGKILL if kill else signal.SIGTERM)
            try:
                self.process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for log in self.logs:
            log.close()
        (self.base / "socket-transcript.json").write_text(json.dumps(self.events, indent=2))
        (self.base / "process.json").write_text(json.dumps({"argv": self.argv,
                                                          "exit": self.process.returncode}, indent=2))
        shutil.rmtree(self.socket_dir)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Runner:
    def __init__(self, args):
        self.evidence = args.evidence_dir.resolve()
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.repo = args.repo.resolve()
        self.engine = self.repo / ".build/release/rushcore-engine"
        self.cli = self.repo / ".build/release/rushes"
        self.probe = self.evidence / "probe-media"
        self.results = []
        self.positive_package = None

    def command(self, argv, destination, timeout=30):
        started = time.monotonic()
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
            evidence = {"argv": argv, "exit": result.returncode, "stdout": result.stdout,
                        "stderr": result.stderr, "seconds": time.monotonic() - started}
        except subprocess.TimeoutExpired as error:
            evidence = {"argv": argv, "exit": None, "timeout": timeout,
                        "stdout": str(error.stdout), "stderr": str(error.stderr)}
        Path(destination).write_text(json.dumps(evidence, indent=2))
        return evidence

    def check(self, name, test):
        try:
            details = test()
            self.results.append({"name": name, "status": "verified", "details": details})
        except Exception as error:
            self.results.append({"name": name, "status": "failed", "error": str(error),
                                 "traceback": traceback.format_exc()})
        print(json.dumps(self.results[-1]), flush=True)

    def decode(self, package):
        manifest = json.loads((package / "manifest.json").read_text())
        paths = [str(package / t["file"]) for t in manifest["tracks"] if t["present"]]
        result = self.command([str(self.probe), *paths], package.parent / "decode.json")
        assert result["exit"] == 0, result
        decoded = json.loads(result["stdout"])
        assert decoded, "no present media tracks decoded"
        return manifest, decoded

    def positive(self):
        with Engine(self, "positive-audio") as engine:
            result = engine.cli(["record", "start", "--system-audio", "--duration", "2", "--wait"])
            assert result["exit"] == 0, result
            done = [json.loads(line) for line in result["stdout"].splitlines()
                    if json.loads(line).get("event") == "done"][-1]["result"]
            assert done["status"] == "complete", done
            package = Path(done["packagePath"])
            manifest, decoded = self.decode(package)
            duration = manifest["clock"]["durationNs"] / 1e9
            assert 1.9 < duration < 2.2, duration
            assert all(abs(item["duration"] - duration) <= .05 for item in decoded), decoded
            verified = engine.cli(["verify", done["id"]])
            assert verified["exit"] == 0 and json.loads(verified["stdout"])["ok"], verified
            self.positive_package = package
            return {"package": str(package), "manifestSeconds": duration, "decoded": decoded}

    def pause(self):
        with Engine(self, "pause-audio") as engine:
            start = engine.request("record.start", {"systemAudio": True})
            assert start["ok"], start
            time.sleep(.8)
            assert engine.request("record.pause")["ok"]
            before = engine.request("status")["result"]["recording"]["elapsedMediaNs"]
            time.sleep(1.3)
            after = engine.request("status")["result"]["recording"]["elapsedMediaNs"]
            assert before == after, {"before": before, "after": after}
            assert engine.request("record.resume")["ok"]
            time.sleep(.8)
            stop = engine.request("record.stop")
            assert stop["ok"], stop
            package = Path(stop["result"]["packagePath"])
            manifest, decoded = self.decode(package)
            clock = manifest["clock"]
            duration = clock["durationNs"] / 1e9
            assert 1.5 < duration < 1.9, duration
            assert all(abs(item["duration"] - duration) <= .05 for item in decoded), decoded
            input_lines = [json.loads(line) for line in (package / "input.ndjson").read_text().splitlines()]
            assert max(item["t"] for item in input_lines) <= duration * 1000 + 50, {
                "contract": "input events use media time after pause removal",
                "manifestSeconds": duration, "lastInputMs": input_lines[-1]["t"]}
            return {"package": str(package), "manifestSeconds": duration, "decoded": decoded}

    def fixture(self, name, mutation):
        assert self.positive_package, "positive control did not produce a package"
        base = self.evidence / name
        root = base / "recordings"
        root.mkdir(parents=True, exist_ok=True)
        ident = "01KVER" + name.upper().replace("-", "")
        package = root / "2026-10-11_01KVER"
        shutil.copytree(self.positive_package, package)
        manifest = json.loads((package / "manifest.json").read_text())
        manifest["id"] = ident
        mutation(package, manifest)
        (package / "manifest.json").write_text(json.dumps(manifest))
        return root, package, ident

    def corruption(self):
        def mutate(package, manifest):
            (package / manifest["tracks"][0]["file"]).write_bytes(b"deliberately not media")
        root, package, ident = self.fixture("corruption", mutate)
        decoder = self.command([str(self.probe), str(package / "system.mov")],
                               package.parent / "negative-decode.json")
        assert decoder["exit"] == 1 and not json.loads(decoder["stdout"])[0]["ok"], decoder
        with Engine(self, "corruption-engine", root) as engine:
            result = engine.cli(["verify", ident])
            report = json.loads(result["stdout"])
            assert not report["ok"], report  # negative control of the decode oracle
            assert result["exit"] != 0, {"contract": "verify must return failing exit for corrupt media", **result}
        return {"package": str(package)}

    def absent(self):
        def mutate(package, manifest):
            manifest["status"] = "failed"
            for track in manifest["tracks"]:
                track["present"] = False
        root, package, ident = self.fixture("no-media", mutate)
        with Engine(self, "no-media-engine", root) as engine:
            result = engine.cli(["verify", ident])
            report = json.loads(result["stdout"])
            assert not report["ok"], {"contract": "a failed take with no present media cannot verify", **result}
        return {"package": str(package)}

    def traversal(self):
        def mutate(package, manifest):
            original = package / manifest["tracks"][0]["file"]
            shutil.copyfile(original, package.parent / "outside.mov")
            manifest["tracks"][0]["file"] = "../outside.mov"
        root, package, ident = self.fixture("path-traversal", mutate)
        with Engine(self, "path-traversal-engine", root) as engine:
            result = engine.cli(["verify", ident])
            report = json.loads(result["stdout"]) if result["stdout"] else None
            assert result["exit"] != 0 and not (report or {}).get("ok"), {
                "contract": "package media paths cannot escape the package", **result}
        return {"package": str(package)}

    def invalid_duration(self):
        with Engine(self, "huge-duration") as engine:
            try:
                reply = engine.request("record.start", {"systemAudio": True, "duration": 1e30})
            except EOFError:
                engine.process.wait(timeout=10)
                raise AssertionError(f"finite untrusted duration 1e30 crashes engine exit={engine.process.returncode}; {engine.base / 'engine.stderr'}")
            assert not reply["ok"], {"contract": "unrepresentable duration must refuse before recording", "reply": reply}
        return {}

    def symlink_escape(self):
        def mutate(package, manifest):
            original = package / manifest["tracks"][0]["file"]
            outside = package.parent / "outside.mov"
            shutil.copyfile(original, outside)
            original.unlink()
            original.symlink_to(outside)
        root, package, ident = self.fixture("symlink-escape", mutate)
        with Engine(self, "symlink-escape-engine", root) as engine:
            result = engine.cli(["verify", ident])
            report = json.loads(result["stdout"]) if result["stdout"] else None
            assert result["exit"] != 0 and not (report or {}).get("ok"), {
                "contract": "canonical media path must stay inside package despite symlinks", **result}
        return {"package": str(package)}

    def wrong_type(self):
        with Engine(self, "wrong-type") as engine:
            reply = engine.request("record.start", {"systemAudio": True, "duration": "bad"})
            if reply["ok"]:
                engine.request("record.stop")
            assert not reply["ok"], {"contract": "duration of wrong JSON type must refuse", "reply": reply}
        return {}

    def invalid_countdown(self):
        with Engine(self, "huge-countdown") as engine:
            try:
                reply = engine.request("record.start", {"systemAudio": True, "countdownSeconds": 1e30})
            except EOFError:
                engine.process.wait(timeout=10)
                raise AssertionError(f"untrusted countdown 1e30 crashes engine exit={engine.process.returncode}; {engine.base / 'engine.stderr'}")
            assert not reply["ok"], {"contract": "unrepresentable countdown must refuse", "reply": reply}
        return {}

    def recovery(self):
        engine = Engine(self, "crash-recovery")
        start = engine.request("record.start", {"systemAudio": True})
        assert start["ok"], start
        package = Path(start["result"]["packagePath"])
        time.sleep(3.3)
        engine.close(kill=True)
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in package.glob("*.mov")}
        with Engine(self, "crash-recovery-restart", engine.root) as restarted:
            time.sleep(.3)
            result = restarted.cli(["show", start["result"]["id"]])
            assert result["exit"] == 0, result
            shown = json.loads(result["stdout"])
            assert shown["manifest"]["status"] == "recovered", shown
            for name, digest in hashes.items():
                assert hashlib.sha256((package / name).read_bytes()).hexdigest() == digest
            manifest, decoded = self.decode(package)
            assert all(item["duration"] >= 2.3 for item in decoded), decoded
            return {"package": str(package), "originalsUnchanged": True, "decoded": decoded}

    def run(self):
        build = self.command(["swiftc", "-parse-as-library", str(self.repo / "verification/ProbeMedia.swift"),
                              "-o", str(self.probe)], self.evidence / "probe-build.json", timeout=60)
        assert build["exit"] == 0, build
        for name, test in [("positive-playable-audio", self.positive),
                           ("pause-shape", self.pause),
                           ("corrupt-media-cli-exit", self.corruption),
                           ("no-media-verification", self.absent),
                           ("manifest-path-traversal", self.traversal),
                           ("media-symlink-escape", self.symlink_escape),
                           ("huge-duration-refusal", self.invalid_duration),
                           ("wrong-type-duration-refusal", self.wrong_type),
                           ("huge-countdown-refusal", self.invalid_countdown),
                           ("crash-recovery-preserves-originals", self.recovery)]:
            self.check(name, test)
        report = {"status": "failed" if any(r["status"] == "failed" for r in self.results) else "verified",
                  "proposition": "Rushes preserves raw recordings and honestly produces playable media; invalid requests refuse safely",
                  "testedRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip(),
                  "evidenceDir": str(self.evidence), "results": self.results,
                  "untested": ["real camera/display/microphone capture", "macOS permission onboarding",
                               "UI, exports and providers before integrated commit",
                               "recovered manifest duration of audio-only package (media decoded only)"]}
        (self.evidence / "report.json").write_text(json.dumps(report, indent=2))
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--evidence-dir", type=Path, required=True)
    arguments = parser.parse_args()
    runner = Runner(arguments)
    try:
        report = runner.run()
        raise SystemExit(0 if report["status"] == "verified" else 1)
    except Exception:
        (runner.evidence / "harness-error.txt").write_text(traceback.format_exc())
        raise
