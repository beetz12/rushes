#!/usr/bin/env python3
"""Declared union gate for the native MAS feasibility diagnostic.

Retains all command output, including failures. This gate accepts an evidenced
feasibility decision and never accepts a Store distribution or live backend.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]


def clean_metric_passes(output):
    return output.splitlines()[:1] == ["0"]


def logged_step(name, argv, output, cwd=ROOT):
    log = output / (name + ".log")
    stderr_log = output / (name + ".stderr.log") if name == "spike-clean-room" else None
    if stderr_log:
        with log.open("wb") as stream, stderr_log.open("wb") as errors:
            result = subprocess.run(argv, cwd=cwd, stdout=stream, stderr=errors)
    else:
        with log.open("wb") as stream:
            result = subprocess.run(argv, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT)
    accepted = result.returncode == 0
    if name == "spike-clean-room":
        accepted = accepted and clean_metric_passes(log.read_text())
    row = {"name": name, "exit": result.returncode, "accepted": accepted, "log": str(log)}
    if stderr_log:
        row["stderrLog"] = str(stderr_log)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    default = ROOT / ".build" / ("mas-spike-gate-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:6] + ".noindex")
    output = (args.output or Path(os.environ.get("RUSHES_MAS_EVIDENCE_DIR", str(default)))).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    steps = [("source", ["bash", "scripts/check-mac-web.sh"]),
             ("receipt-controls", [sys.executable, "-m", "unittest", "discover", "-s", "verification/mas-spike", "-p", "test_*.py", "-v"]),
             ("spike-clean-room", [sys.executable, "-I", "tools/checks/check_clean.py", "scripts/mas-spike", "verification/mas-spike", "docs/distribution/mas-feasibility.md"]),
             ("fresh-native-probe", [sys.executable, "scripts/mas-spike/run.py", "--output", str(output / "fresh-native-probe")]),
             ("independent-receipt", [sys.executable, "verification/mas-spike/verify.py", str(output / "fresh-native-probe/receipt.json")])]
    results = []
    for name, argv in steps:
        result = logged_step(name, argv, output)
        results.append(result)
        print(json.dumps(results[-1]), flush=True)
        if not result["accepted"]:
            (output / "gate.json").write_text(json.dumps({"passed": False, "results": results}, indent=2))
            return result["exit"] or 1
    (output / "gate.json").write_text(json.dumps({"passed": True, "storeReady": False, "results": results}, indent=2))
    print("MAS spike gate passed: source, receipt controls and fresh native sandbox decision; Store readiness remains false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
