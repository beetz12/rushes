#!/usr/bin/env python3
"""Verify file provenance and pinned, distributed direct dependency notices."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CODE_ROOTS = ("Sources", "Tests", "shell/src", "cloud/src", "viewer/src", "worker/src", "browser/src", "browser-worker/src")
PACKAGES = ("shell", "cloud", "viewer", "worker", "browser", "browser-worker")
ALLOWED = {"MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "Zlib", "CC0-1.0", "0BSD"}
DEPENDENCY_START = "<!-- pinned-npm-notices:start -->"
DEPENDENCY_END = "<!-- pinned-npm-notices:end -->"


def dependencies():
    for surface in PACKAGES:
        manifest = ROOT / surface / "package.json"
        if not manifest.exists():
            continue
        package = json.loads(manifest.read_text())
        for name in sorted(set(package.get("dependencies", {})) | set(package.get("devDependencies", {}))):
            installed = ROOT / surface / "node_modules" / name / "package.json"
            if not installed.exists():
                raise RuntimeError(f"dependency metadata unavailable: {surface}/{name}; run its declared npm install")
            metadata = json.loads(installed.read_text())
            license_id = metadata.get("license", "")
            if not isinstance(license_id, str):
                raise RuntimeError(f"unsupported license metadata: {surface}/{name}")
            parts = set(re.findall(r"[A-Za-z0-9][A-Za-z0-9.+-]*", license_id)) - {"AND", "OR"}
            if not parts or not parts.issubset(ALLOWED):
                raise RuntimeError(f"dependency license needs review: {surface}/{name}: {license_id}")
            yield surface, name, metadata["version"], license_id, installed.parent


def license_name(name, version):
    return f"npm-{name.replace('@', '').replace('/', '-')}-{version}.txt"


def collect():
    """Explicit authoring step; never invoked by the read-only verifier."""
    rows = []
    for surface, name, version, license_id, directory in dependencies():
        candidates = sorted(f for f in directory.iterdir() if f.is_file() and
                            f.name.lower().startswith(("license", "licence", "copying")))
        if not candidates:
            raise RuntimeError(f"full dependency license text missing: {surface}/{name}@{version}")
        text = "\n\n".join(f.read_text(errors="strict") for f in candidates)
        target = ROOT / "licenses" / license_name(name, version)
        target.write_text(text)
        rows.append(f"| npm: {surface}/{name}@{version} | {license_id} | {target.relative_to(ROOT)} |")
    block = "\n".join([DEPENDENCY_START, "## Pinned direct npm dependencies", "",
                        "These build and runtime dependencies are included in acknowledgements.", "",
                        "| Package and installed version | Licence | Full licence text |",
                        "|---|---|---|", *rows, DEPENDENCY_END])
    notice_file = ROOT / "THIRD_PARTY_NOTICES.md"
    text = notice_file.read_text()
    if DEPENDENCY_START in text:
        text = re.sub(re.escape(DEPENDENCY_START) + r"[\s\S]*?" + re.escape(DEPENDENCY_END),
                      lambda _: block, text)
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    notice_file.write_text(text)
    print(f"Collected {len(rows)} direct npm dependency notices")


def verify():
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text()
    failures = []
    derived = 0
    for directory in CODE_ROOTS:
        base = ROOT / directory
        if not base.exists():
            continue
        for file in base.rglob("*"):
            if not file.is_file() or file.suffix not in {".swift", ".ts", ".tsx", ".js", ".mjs", ".cjs"}:
                continue
            if "Derived from " in file.read_text():
                derived += 1
                path = file.relative_to(ROOT).as_posix()
                if not any(line.startswith(f"| {path} |") for line in notices.splitlines()):
                    failures.append(f"missing exact provenance row: {path}")
    for line in notices.splitlines():
        if not line.startswith("| "):
            continue
        value = line.split("|")[1].strip().strip("`")
        if value.startswith(tuple(f"{p}/" for p in ("Sources", "Tests", "shell", "cloud", "worker", "viewer", "browser", "browser-worker"))) and not (ROOT / value).is_file():
            failures.append(f"notice names absent file: {value}")
        for path in re.findall(r"licenses/[A-Za-z0-9_.@/-]+", line):
            if not (ROOT / path).is_file():
                failures.append(f"full licence text missing: {path}")
    count = 0
    for surface, name, version, license_id, _ in dependencies():
        count += 1
        expected = f"| npm: {surface}/{name}@{version} | {license_id} | licenses/{license_name(name, version)} |"
        if expected not in notices:
            failures.append(f"missing pinned dependency notice: {surface}/{name}@{version}")
    if failures:
        raise RuntimeError("\n".join(failures))
    print(f"OK notices: {derived} derived files; {count} pinned direct npm dependencies")


if __name__ == "__main__":
    import sys
    try:
        collect() if sys.argv[1:] == ["--collect"] else verify()
    except (OSError, ValueError, RuntimeError) as error:
        print(f"notice verification failed: {error}", file=sys.stderr)
        sys.exit(1)
