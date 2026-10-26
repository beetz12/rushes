#!/usr/bin/env python3
"""Run a bounded local App Sandbox experiment without changing installed Rushes.

The native parent is ad-hoc signed. Its success is deliberately not an Electron
MAS, physical capture, provisioning, App Review or production acceptance result.
All generated bundles and raw logs are retained in the requested output folder.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import struct
import stat
import sys
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def macho_sections(path):
    data = Path(path).read_bytes()
    if data[:4] != b"\xcf\xfa\xed\xfe":
        raise RuntimeError("Expected the current arm64 little-endian Mach-O helper")
    count = struct.unpack_from("<I", data, 16)[0]
    cursor, result = 32, {}
    for _ in range(count):
        command, size = struct.unpack_from("<II", data, cursor)
        if command == 0x19:
            sections = struct.unpack_from("<I", data, cursor + 64)[0]
            for index in range(sections):
                base = cursor + 72 + index * 80
                name = data[base:base + 16].rstrip(b"\0").decode()
                segment = data[base + 16:base + 32].rstrip(b"\0").decode()
                length = struct.unpack_from("<Q", data, base + 40)[0]
                offset, flags = struct.unpack_from("<I", data, base + 48)[0], struct.unpack_from("<I", data, base + 64)[0]
                if length and flags & 0xFF not in (1, 12, 18):
                    result[segment + "," + name] = {"size": length, "sha256": hashlib.sha256(data[offset:offset + length]).hexdigest()}
        cursor += size
    if "__TEXT,__text" not in result:
        raise RuntimeError("No native executable instructions were measured")
    return result


def execute(argv, destination, timeout=120):
    try:
        completed = subprocess.run([str(a) for a in argv], capture_output=True, text=True,
                                   timeout=timeout, cwd=ROOT)
        result = {"argv": [str(a) for a in argv], "exit": completed.returncode,
                  "stdout": completed.stdout, "stderr": completed.stderr, "timedOut": False}
    except subprocess.TimeoutExpired as error:
        result = {"argv": [str(a) for a in argv], "exit": None,
                  "stdout": str(error.stdout or ""), "stderr": str(error.stderr or ""), "timedOut": True}
    destination.write_text(json.dumps(result, indent=2))
    return result


def must(argv, destination, timeout=120):
    result = execute(argv, destination, timeout)
    if result["exit"] != 0 or result["timedOut"]:
        raise RuntimeError(f"Tool failed: {argv[0]}; evidence={destination}")
    return result


def owned_command(argv, destination, timeout):
    """Observe and drain the new session even if the diagnostic parent fails."""
    stdout, stderr = destination.with_suffix(".stdout"), destination.with_suffix(".stderr")
    with stdout.open("wb") as out, stderr.open("wb") as err:
        child = subprocess.Popen([str(a) for a in argv], cwd=ROOT, stdout=out, stderr=err, start_new_session=True)
        timed_out = False
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        observations = []
        for retirement_signal in (None, "TERM", "KILL", None, None):
            inspect = [sys.executable, str(ROOT / "shell/scripts/helper-session.py"), str(child.pid)]
            if retirement_signal:
                inspect += ["--signal", retirement_signal]
            raw = subprocess.run(inspect, capture_output=True, text=True, timeout=5, check=True)
            observation = json.loads(raw.stdout)
            observations.append(observation)
            time.sleep(.05)
        if child.poll() is None:
            child.wait(timeout=5)
    cleaned = not observations[-1]["members"] and not observations[-2]["members"]
    result = {"argv": [str(a) for a in argv], "exit": child.returncode, "stdout": stdout.read_text(),
              "stderr": stderr.read_text(), "timedOut": timed_out,
              "ownership": {"session": child.pid, "retirementConfirmed": cleaned, "observations": observations}}
    destination.write_text(json.dumps(result, indent=2))
    if not cleaned:
        raise RuntimeError("Owned diagnostic session did not retire; see " + str(destination))
    return result


def signing_inventory(output):
    identity = execute(["security", "find-identity", "-v", "-p", "codesigning"], output / "identities.json", 10)
    profiles = []
    for folder in [Path.home() / "Library/MobileDevice/Provisioning Profiles",
                   Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"]:
        for path in sorted(folder.glob("*")):
            if path.suffix not in (".mobileprovision", ".provisionprofile"):
                continue
            raw = subprocess.run(["security", "cms", "-D", "-i", str(path)], capture_output=True, timeout=10)
            row = {"path": str(path), "sha256": digest(path), "decodeExit": raw.returncode}
            if raw.returncode == 0:
                profile = plistlib.loads(raw.stdout)
                entitlement = profile.get("Entitlements", {})
                row.update({"name": profile.get("Name"), "platform": profile.get("Platform", []),
                            "teams": profile.get("TeamIdentifier", []),
                            "applicationIdentifier": entitlement.get("application-identifier") or entitlement.get("com.apple.application-identifier"),
                            "expiration": str(profile.get("ExpirationDate")),
                            "appSandbox": entitlement.get("com.apple.security.app-sandbox", False)})
            profiles.append(row)
    return {"identityCommandExit": identity["exit"], "identities": identity["stdout"], "profiles": profiles,
            "profileSearchDirectories": [str(Path.home() / "Library/MobileDevice/Provisioning Profiles"),
                                         str(Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles")]}


def sign_bundle(bundle, sandbox, output, label):
    parent = {"com.apple.security.app-sandbox": True, "com.apple.security.network.client": True,
              "com.apple.security.network.server": True, "com.apple.security.files.user-selected.read-write": True}
    child = {"com.apple.security.app-sandbox": True, "com.apple.security.inherit": True}
    for name, value in [("parent", parent), ("child", child)]:
        (output / (name + ".plist")).write_bytes(plistlib.dumps(value))
    for name in ("rushcore-engine", "rushes"):
        binary = bundle / "Contents/Resources/bin" / name
        command = ["codesign", "--force", "--sign", "-", "--timestamp=none", "--identifier", "com.nexai.rushes.masprobe." + name]
        if sandbox:
            command += ["--entitlements", str(output / "child.plist")]
        must(command + [binary], output / (label + "-sign-" + name + ".json"))
    command = ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    if sandbox:
        command += ["--entitlements", str(output / "parent.plist")]
    must(command + [bundle], output / (label + "-sign-parent.json"))
    must(["codesign", "--verify", "--deep", "--strict", "--verbose=2", bundle], output / (label + "-signature-verify.json"))
    entitlements = {}
    for name, target in [("parent", bundle), ("engine", bundle / "Contents/Resources/bin/rushcore-engine"),
                         ("cli", bundle / "Contents/Resources/bin/rushes")]:
        row = must(["codesign", "--display", "--entitlements", ":-", target], output / (label + "-entitlements-" + name + ".json"))
        if row["stdout"].strip():
            entitlements[name] = plistlib.loads(row["stdout"].encode())
        else:
            entitlements[name] = {}
    return entitlements


def inspect_media(native, output, probe):
    findings = []
    for row in native.get("rounds", []):
        package, exports = row.get("package"), row.get("exports")
        if not package or not exports:
            continue
        package, exports = Path(package), Path(exports)
        manifest = json.loads((package / "manifest.json").read_text())
        originals = [package / track["file"] for track in manifest["tracks"] if track["present"]]
        combined = exports / "combined.mp4"
        inputs = originals + [combined]
        decoded = execute([probe, *inputs], output / f"decode-{row['round']}.json", 90)
        equality = {p.name: {"originalSha256": digest(p),
                   "exportSha256": digest(exports / "originals" / p.name)}
                    for p in originals if (exports / "originals" / p.name).is_file()}
        bound_media = inputs + [exports / "originals" / p.name for p in originals]
        bound_media += [package / "manifest.json", exports / "originals/offsets.json"]
        findings.append({"round": row["round"], "manifest": manifest, "originalHashes": equality,
                         "mediaHashes": {str(p): digest(p) for p in bound_media},
                         "decodeExit": decoded["exit"], "decoded": json.loads(decoded["stdout"]) if decoded["exit"] == 0 else [],
                         "package": str(package), "exports": str(exports)})
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    lock_root = Path.home() / "Library/Application Support/RushesMASProbe"
    lock_root.mkdir(parents=True, exist_ok=True)
    lock = (lock_root / "runner.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    nonce = uuid.uuid4().hex[:10]
    attempt = output / (datetime.now(timezone.utc).strftime("attempt-%Y%m%dT%H%M%SZ-") + nonce + ".noindex")
    attempt.mkdir(mode=0o700)
    if sys.platform != "darwin":
        raise RuntimeError("This diagnostic requires macOS; no native test was performed")
    source_paths = [ROOT / "Package.swift", ROOT / "scripts/mas-spike/Probe.swift", ROOT / "verification/ProbeMedia.swift",
                    ROOT / "shell/package.json", ROOT / "shell/build/entitlements.mac.plist"]
    source_paths += sorted((ROOT / "Sources").rglob("*.swift"))
    source_paths += sorted((ROOT / "scripts/mas-spike").glob("*.py"))
    source_paths += sorted((ROOT / "verification/mas-spike").glob("*.py"))
    source_before = {str(p): digest(p) for p in source_paths}
    bundle = attempt / "MASProbe.app"
    executable = bundle / "Contents/MacOS/MASProbe"
    executable.parent.mkdir(parents=True)
    binaries = bundle / "Contents/Resources/bin"
    binaries.mkdir(parents=True)
    for name in ("rushcore-engine", "rushes"):
        source = ROOT / ".build/debug" / name
        if not source.is_file():
            raise RuntimeError("Run the declared Swift build before this diagnostic")
        shutil.copy2(source, binaries / name)
    (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.nexai.rushes.masprobe",
        "CFBundleName": "MASProbe", "CFBundleExecutable": "MASProbe", "CFBundlePackageType": "APPL",
        "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0", "LSUIElement": True}))
    must(["xcrun", "swiftc", ROOT / "scripts/mas-spike/Probe.swift", "-o", executable], attempt / "build-parent.json", 90)
    probe = attempt / "probe-media"
    must(["xcrun", "swiftc", "-parse-as-library", ROOT / "verification/ProbeMedia.swift", "-o", probe], attempt / "build-decoder.json", 90)
    outside = Path.home() / (".rushes-mas-outside-" + nonce)
    owned_socket = Path.home() / "Library/Containers/com.nexai.rushes.masprobe/Data/.s" / (nonce[:6] + ".sock")
    if owned_socket.exists():
        raise RuntimeError("Refusing a preexisting diagnostic socket")
    try:
        sign_bundle(bundle, False, attempt, "control")
        control = owned_command([executable, outside, nonce + "-control", "--filesystem-only"], attempt / "control-run.json", 20)
        if control["exit"] != 0:
            raise RuntimeError("Unsandboxed control failed; inspect control-run.json")
        control_native = json.loads(control["stdout"])
        if control_native.get("outsideWrite", {}).get("allowed") is not True or not outside.is_file():
            raise RuntimeError("Unsandboxed positive control could not write its owned outside marker")
        outside.unlink()
        signed = sign_bundle(bundle, True, attempt, "sandbox")
        native_run = owned_command([executable, outside, nonce], attempt / "sandbox-run.json", 300)
        forced_socket_removal = False
        if owned_socket.exists():
            if not stat.S_ISSOCK(owned_socket.lstat().st_mode):
                raise RuntimeError("Unexpected file at the new owned socket path")
            owned_socket.unlink()
            forced_socket_removal = True
        native_run["ownership"]["socket"] = {"path": str(owned_socket), "absentBefore": True,
            "absentAfter": not owned_socket.exists(), "forcedRemoval": forced_socket_removal}
        (attempt / "sandbox-run.json").write_text(json.dumps(native_run, indent=2))
        native = json.loads(native_run["stdout"]) if native_run["exit"] == 0 else None
        media = inspect_media(native, attempt, probe) if native else []
        inventory = signing_inventory(attempt)
        files = {str(p): digest(p) for p in source_paths}
        if files != source_before:
            raise RuntimeError("Source changed during the actual experiment; evidence cannot qualify that source")
        compiled = {str(binaries / name): digest(binaries / name) for name in ("rushcore-engine", "rushes")}
        binary_binding = []
        for name in ("rushcore-engine", "rushes"):
            original, signed_copy = ROOT / ".build/debug" / name, binaries / name
            original_sections, signed_sections = macho_sections(original), macho_sections(signed_copy)
            if original_sections != signed_sections:
                raise RuntimeError("Signing changed native helper loadable sections")
            binary_binding.append({"original": str(original), "originalSha256": digest(original),
                                   "signedCopy": str(signed_copy), "signedSha256": digest(signed_copy),
                                   "loadableSections": signed_sections})
        receipt = {"schema": "rushes.mas-feasibility/1", "createdAt": datetime.now(timezone.utc).isoformat(),
            "experimentCompleted": True, "appStoreReady": False, "electronMASAccepted": False,
            "provisionedMASAccepted": False, "physicalCaptureAccepted": False,
            "signingMode": "native-adhoc", "repo": str(ROOT),
            "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "sourceHashes": files, "binaryHashes": compiled, "binaryBinding": binary_binding, "attempt": str(attempt),
            "control": control_native, "signedEntitlements": signed,
            "nativeLaunch": {k: native_run[k] for k in ("exit", "timedOut")},
            "ownedRetirement": native_run["ownership"], "native": native,
            "media": media, "signingInventory": inventory,
            "electronMAS": {"status": "not-run", "reason": "This native-only probe does not execute the Electron MAS shell. The scoped local signing/profile inventory is reported separately; it does not establish paid account membership or full MAS compatibility.",
                            "electronVersion": json.loads((ROOT / "shell/package.json").read_text())["devDependencies"]["electron"]},
            "untested": ["Electron MAS shell execution", "physical screen/camera/microphone/system-audio capture", "area picker",
                         "user-selected export/security-scoped bookmark across restart", "production library/Keychain migration",
                         "global hotkeys/App Intents under MAS", "App Store signing/submission"]}
        receipt["artifactHashes"] = {str(p): digest(p) for p in attempt.rglob("*") if p.is_file() and p.name != "receipt.json"}
        (attempt / "receipt.json").write_text(json.dumps(receipt, indent=2))
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2))
        print(json.dumps({"receipt": str(output / "receipt.json"), "nativeLaunchExit": native_run["exit"],
                          "experimentCompleted": True, "appStoreReady": False, "electronMASAccepted": False}))
        return 0
    finally:
        for path in [outside, outside.with_suffix(".sqlite"), Path(str(outside.with_suffix(".sqlite")) + "-wal"),
                     Path(str(outside.with_suffix(".sqlite")) + "-shm"), Path(str(outside.with_suffix(".sqlite")) + "-journal")]:
            if path.exists():
                path.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
