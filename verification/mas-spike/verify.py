#!/usr/bin/env python3
"""Independently check a native sandbox diagnostic and reject Store overclaims."""
from argparse import ArgumentParser
import hashlib
import json
from math import isfinite
import os
from pathlib import Path
import plistlib
import subprocess
import struct


def require(condition, message):
    if not condition:
        raise ValueError(message)


def hashes(mapping):
    require(isinstance(mapping, dict) and len(mapping) > 0, "Missing source/artifact binding")
    for name, expected in mapping.items():
        path = Path(name)
        require(path.is_file(), "Missing bound file: " + name)
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, "Changed bound file: " + name)


def media_hash_set(media, manifest):
    package, exports = Path(media["package"]), Path(media["exports"])
    names = [track["file"] for track in manifest["tracks"] if track["present"]]
    expected = {str(package / name) for name in names}
    expected.update(str(exports / "originals" / name) for name in names)
    expected.update([str(package / "manifest.json"), str(exports / "combined.mp4"),
                     str(exports / "originals/offsets.json")])
    require(set(media.get("mediaHashes", {})) == expected, "Saved media hash coverage is incomplete or contains unexpected paths")


def loadable_sections(path):
    data = Path(path).read_bytes()
    require(data[:4] == b"\xcf\xfa\xed\xfe", "Expected little-endian 64-bit Mach-O")
    cursor, result = 32, {}
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        kind, length = struct.unpack_from("<II", data, cursor)
        if kind == 0x19:
            for index in range(struct.unpack_from("<I", data, cursor + 64)[0]):
                offset = cursor + 72 + index * 80
                section = data[offset:offset + 16].split(b"\0")[0].decode()
                segment = data[offset + 16:offset + 32].split(b"\0")[0].decode()
                size = struct.unpack_from("<Q", data, offset + 40)[0]
                file_offset = struct.unpack_from("<I", data, offset + 48)[0]
                section_type = struct.unpack_from("<I", data, offset + 64)[0] & 0xFF
                if size and section_type not in (1, 12, 18):
                    result[segment + "," + section] = {"size": size,
                        "sha256": hashlib.sha256(data[file_offset:file_offset + size]).hexdigest()}
        cursor += length
    return result


def native_decision(receipt):
    require(receipt.get("schema") == "rushes.mas-feasibility/1", "Unknown receipt schema")
    require(receipt.get("experimentCompleted") is True, "Experiment incomplete")
    for key in ("appStoreReady", "electronMASAccepted", "provisionedMASAccepted", "physicalCaptureAccepted"):
        require(receipt.get(key) is False, "Native diagnostic cannot qualify " + key)
    require(receipt.get("signingMode") == "native-adhoc", "Unexpected signing mode")
    require(receipt.get("electronMAS", {}).get("status") == "not-run", "Electron evidence not present")
    require(bool(receipt["electronMAS"].get("reason")), "Missing Electron prerequisite")
    signed = receipt.get("signedEntitlements", {})
    parent = signed.get("parent", {})
    require(parent.get("com.apple.security.app-sandbox") is True, "Missing parent App Sandbox entitlement")
    require("com.apple.security.inherit" not in parent, "Parent must not inherit a nonexistent sandbox")
    require(parent == {"com.apple.security.app-sandbox": True, "com.apple.security.network.client": True,
                       "com.apple.security.network.server": True, "com.apple.security.files.user-selected.read-write": True},
            "Unexpected parent sandbox rights")
    for name in ("engine", "cli"):
        require(signed.get(name) == {"com.apple.security.app-sandbox": True, "com.apple.security.inherit": True},
                "Helper inheritance mismatch: " + name)
    require(not any("temporary-exception" in key for ent in signed.values() for key in ent), "Sandbox exception forbidden")
    control = receipt.get("control", {})
    require(control.get("sandboxEntitlement") in (None, False), "Unsandboxed control is sandboxed")
    require(control.get("outsideWrite", {}).get("allowed") is True, "Outside target was not writable in the control")
    require(control.get("containerWrite") is True, "Control write failed")
    ownership = receipt.get("ownedRetirement", {})
    observations = ownership.get("observations", [])
    require(ownership.get("retirementConfirmed") is True and len(observations) >= 2,
            "Diagnostic session retirement unconfirmed")
    require(ownership.get("session", 0) > 1 and all(row.get("session") == ownership["session"] for row in observations),
            "Diagnostic session identity mismatch")
    require(all(row.get("members") == [] for row in observations[-2:]), "Diagnostic descendants remain after parent completion")
    socket = ownership.get("socket", {})
    require(socket.get("absentBefore") is True and socket.get("absentAfter") is True and bool(socket.get("path")),
            "Diagnostic socket cleanup unconfirmed")
    launch = receipt.get("nativeLaunch", {})
    if launch.get("exit") != 0:
        require(isinstance(launch.get("exit"), int), "Diagnostic launch timed out or missing actual exit")
        return {"spikeDecisionVerified": True, "nativeMechanicsAccepted": False,
                "nativeBlocker": "Signed local native parent could not complete; inspect sandbox-run.json actual exit",
                "electronMASAccepted": False, "appStoreReady": False}
    native = receipt.get("native", {})
    require(socket["path"] == native.get("socket") and socket.get("forcedRemoval") is False,
            "Successful native lifecycle did not retire its own socket")
    require(native.get("sandboxEntitlement") is True, "Runtime SecTask does not report App Sandbox")
    require(native.get("containerWrite") is True, "Runtime container write did not succeed")
    require("/Library/Containers/com.nexai.rushes.masprobe/Data" in native.get("home", ""), "Native home did not resolve into its own container")
    outside = native.get("outsideWrite", {})
    require(outside.get("allowed") is False and outside.get("underlyingDomain") == "NSPOSIXErrorDomain"
            and outside.get("underlyingCode") in (1, 13), "No actual sandbox denial for the writable outside target")
    require(native.get("physicalCapture") is False, "Generated scope mismatch")
    denied = native.get("helperOutsideIndex", {})
    require(denied.get("exit") == 1 and denied.get("timedOut") is False and "index-open-failed" in denied.get("stderr", ""),
            "Inherited helper did not refuse the outside index")
    rounds, media = native.get("rounds", []), receipt.get("media", [])
    require(len(rounds) == len(media) == 2, "Need two measured native lifecycles")
    expected_tracks = {"screen", "camera", "microphone", "systemAudio"}
    for index, (row, decoded) in enumerate(zip(rounds, media), 1):
        require(row.get("round") == decoded.get("round") == index, "Round binding mismatch")
        retirement = row.get("retirement", {})
        require(retirement.get("exited") is True and retirement.get("socketAbsent") is True and retirement.get("exit") == 0,
                "Native helper cleanup incomplete")
        take = row.get("recording", {})
        require(take.get("status") == "complete", "Take was not complete")
        require({t["kind"] for t in take.get("tracks", [])} == expected_tracks, "Not all four source tracks captured")
        require(all(t["finalizeState"] == "finalized" and t["framesWritten"] > 0 for t in take["tracks"]), "Empty/unfinalized original track")
        commands = row.get("requests", [])
        require(len(commands) == 7 and all(c.get("exit") == 0 and c.get("timedOut") is False for c in commands), "Native request failed or omitted")
        require(json.loads(commands[0]["stdout"]).get("pong") is True, "No actual helper ping response")
        status = json.loads(commands[1]["stdout"])
        require(status.get("pid") == row.get("pid") and status.get("state") == "idle", "Status came from another helper or was not idle")
        listing = json.loads(commands[2]["stdout"])["recordings"]
        if index == 2:
            require(rounds[0]["recording"]["id"] in {r["id"] for r in listing}, "Restart lost prior recording")
        require(json.loads(commands[4]["stdout"]).get("ok") is True, "Package verification did not pass")
        require(json.loads(row["engineLog"].splitlines()[0]).get("capture") == "stub", "Helper was not in generated-capture mode")
        before = row.get("originalHashesBeforeExport", {})
        after = decoded.get("originalHashes", {})
        require(len(before) == len(after) == 4, "Missing before/after original binding")
        for name, hash_row in after.items():
            require(before.get(name) == hash_row.get("originalSha256") == hash_row.get("exportSha256"), "Export changed original bytes")
        require(decoded.get("decodeExit") == 0 and len(decoded.get("decoded", [])) == 5, "Original/composite independent decode missing")
        seconds = take["durationMs"] / 1000
        for asset in decoded["decoded"]:
            require(asset.get("ok") is True and isfinite(asset["duration"]) and abs(asset["duration"] - seconds) < .06,
                    "Saved media extent does not match the generated take")
            require(bool(asset.get("decodedTracks")) and all(track["samples"] > 0 for track in asset["decodedTracks"]), "Independent decode found empty media")
        expected_paths = {str(Path(row["package"]) / name) for name in before}
        expected_paths.add(str(Path(row["exports"]) / "combined.mp4"))
        require({asset.get("path") for asset in decoded["decoded"]} == expected_paths,
                "Independent decoder measured another asset or substituted a track")
        require(decoded.get("package") == row["package"] and decoded.get("exports") == row["exports"], "Media package binding mismatch")
    return {"spikeDecisionVerified": True, "nativeMechanicsAccepted": True, "generatedLifecycles": 2,
            "electronMASAccepted": False, "appStoreReady": False,
            "remaining": receipt.get("untested", [])}


def verify(path):
    receipt = json.loads(Path(path).read_text())
    hashes(receipt.get("sourceHashes"))
    hashes(receipt.get("binaryHashes"))
    hashes(receipt.get("artifactHashes"))
    require(len(receipt.get("revision", "")) == 40, "Missing actual Git revision")
    require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=receipt["repo"], text=True).strip() == receipt["revision"],
            "Source revision changed")
    attempt = Path(receipt["attempt"])
    raw = json.loads((attempt / "sandbox-run.json").read_text())
    require(receipt["nativeLaunch"] == {key: raw[key] for key in ("exit", "timedOut")}, "Launch result not bound to raw command")
    require(receipt["ownedRetirement"] == raw.get("ownership"), "Session retirement not bound to driver observations")
    if raw["exit"] == 0:
        require(receipt["native"] == json.loads(raw["stdout"]), "Native result not bound to actual stdout")
    control = json.loads((attempt / "control-run.json").read_text())
    require(control["exit"] == 0 and receipt["control"] == json.loads(control["stdout"]), "Control not bound to actual stdout")
    for name in ("parent", "engine", "cli"):
        row = json.loads((attempt / ("sandbox-entitlements-" + name + ".json")).read_text())
        require(row["exit"] == 0 and plistlib.loads(row["stdout"].encode()) == receipt["signedEntitlements"][name], "Signed entitlement read-back mismatch")
    for binding in receipt.get("binaryBinding", []):
        require(hashlib.sha256(Path(binding["original"]).read_bytes()).hexdigest() == binding["originalSha256"], "Original built helper changed")
        require(hashlib.sha256(Path(binding["signedCopy"]).read_bytes()).hexdigest() == binding["signedSha256"], "Signed helper changed")
        require("__TEXT,__text" in binding.get("loadableSections", {}), "Native code section binding absent")
        require(loadable_sections(binding["original"]) == loadable_sections(binding["signedCopy"]) == binding["loadableSections"],
                "Signed helper loadable sections differ from the original built helper")
    require(len(receipt.get("binaryBinding", [])) == 2, "Unchanged real helper binding missing")
    decision = native_decision(receipt)
    require(not Path(receipt["ownedRetirement"]["socket"]["path"]).exists(), "Owned diagnostic socket is still present")
    session = receipt["ownedRetirement"]["session"]
    snapshot = subprocess.check_output(["ps", "-ax", "-o", "pid="], text=True)
    for line in snapshot.splitlines():
        try:
            require(os.getsid(int(line.strip())) != session, "Owned diagnostic session is still present")
        except ProcessLookupError:
            pass
    if decision["nativeMechanicsAccepted"]:
        for row in receipt["native"]["rounds"]:
            try:
                os.kill(row["pid"], 0)
            except ProcessLookupError:
                pass
            else:
                raise ValueError("Owned helper PID is still present")
        require(not Path(receipt["native"]["socket"]).exists(), "Owned helper socket is still present")
        for index, media in enumerate(receipt["media"], 1):
            manifest = Path(media["package"]) / "manifest.json"
            actual_manifest = json.loads(manifest.read_text())
            require(actual_manifest == media["manifest"], "Actual saved manifest changed")
            media_hash_set(media, actual_manifest)
            hashes(media.get("mediaHashes"))
            originals = [str(Path(media["package"]) / track["file"]) for track in media["manifest"]["tracks"] if track["present"]]
            expected = originals + [str(Path(media["exports"]) / "combined.mp4")]
            raw = json.loads((attempt / f"decode-{index}.json").read_text())
            require(raw["exit"] == 0 and json.loads(raw["stdout"]) == media["decoded"], "Decoded media not bound to actual independent decoder output")
            require(raw["argv"] == [str(attempt / "probe-media"), *expected], "Independent decoder argument/role binding mismatch")
            for name, row in media["originalHashes"].items():
                original = Path(media["package"]) / name
                exported = Path(media["exports"]) / "originals" / name
                require(hashlib.sha256(original.read_bytes()).hexdigest() == row["originalSha256"]
                        and hashlib.sha256(exported.read_bytes()).hexdigest() == row["exportSha256"],
                        "Actual original/export media changed after observation")
    return decision


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.receipt), sort_keys=True))
