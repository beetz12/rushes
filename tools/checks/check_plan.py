#!/usr/bin/env python3
"""Check docs/PLAN.md, the Loom-clone build plan.

Usage: check_plan.py [docs/PLAN.md]
Prints one line per failure and exits 1 if any check fails; else prints OK.
Run with python3 -I.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import AREAS, REPO, REUSE_MODES, SOURCES, is_permissive_path, section  # noqa: E402

HEADINGS = ["Summary", "Product scope", "Feature matrix", "Architecture", "Recording pipeline",
            "Project format", "Editing and export", "Transcription and AI", "Sharing and viewer",
            "Roadmap", "Clean-room rules for the build", "Open decisions", "Risks",
            "Sources and licences", "Ideas considered"]
MATRIX_MODES = REUSE_MODES | {"own-design"}
MIN_WORDS = 3000
MAX_FENCE_LINES = 40


def slug_mentions(text: str) -> set:
    return {s for s in SOURCES if re.search(rf"(?<![\w-]){re.escape(s)}(?![\w-])", text, flags=re.I)}


def main() -> int:
    plan = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "docs" / "PLAN.md"
    errs = []
    if not plan.is_file():
        print(f"missing {plan}")
        return 1
    text = plan.read_text()

    for h in HEADINGS:
        if not re.search(rf"^## {re.escape(h)}\s*$", text, flags=re.M):
            errs.append(f"missing heading '## {h}'")
    words = len(re.findall(r"\w+", text))
    if words < MIN_WORDS:
        errs.append(f"{words} words, need >= {MIN_WORDS}")

    # Fenced blocks are allowed for our own schemas and interfaces, but kept short.
    for m in re.finditer(r"^```[^\n]*\n(.*?)^```", text, flags=re.M | re.S):
        n = m.group(1).count("\n")
        if n > MAX_FENCE_LINES:
            line = text[: m.start()].count("\n") + 1
            errs.append(f"fenced block at line {line} has {n} lines, max {MAX_FENCE_LINES}")

    # Feature matrix: | Area | Phase | Best source | Licence | Reuse mode | Approach |
    seen = set()
    for row in section(text, "Feature matrix").splitlines():
        if not row.strip().startswith("|"):
            continue
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        ids = re.findall(r"`([a-z-]+)`", cells[0]) if cells else []
        area = next((i for i in ids if i in AREAS), None)
        if not area:
            continue
        seen.add(area)
        if len(cells) < 6:
            errs.append(f"matrix row {area}: needs 6 columns (Area | Phase | Best source | Licence | Reuse mode | Approach)")
            continue
        source_cell, mode_cell = cells[2], cells[4]
        modes = [m for m in MATRIX_MODES if re.search(rf"(?<![\w-]){re.escape(m)}(?![\w-])", mode_cell)]
        if not modes:
            errs.append(f"matrix row {area}: reuse mode must name one of {sorted(MATRIX_MODES)}")
        slugs = slug_mentions(source_cell)
        if not slugs and "own-design" not in modes:
            errs.append(f"matrix row {area}: best source names no reference repo (use own-design if none)")
        if "copy-with-notice" in modes:
            paths = re.findall(r"`([^`]+)`", source_cell)
            for s in slugs:
                if SOURCES[s]["class"] == "copyleft" and not any(is_permissive_path(s, p) for p in paths):
                    errs.append(f"matrix row {area}: copy-with-notice from copyleft '{s}' without a permissive path")
    for area in AREAS:
        if area not in seen:
            errs.append(f"feature matrix has no row for `{area}`")

    # Every repo appears, and the sources section states each licence.
    missing = set(SOURCES) - slug_mentions(text)
    if missing:
        errs.append(f"plan never mentions: {sorted(missing)}")
    src_sec = section(text, "Sources and licences")
    for s, info in SOURCES.items():
        if not re.search(rf"(?<![\w-]){re.escape(s)}(?![\w-])", src_sec, flags=re.I):
            errs.append(f"Sources and licences: no entry for {s}")
    for token in ("AGPL", "GPL", "MIT", "CC0", "BSD"):
        if token not in src_sec:
            errs.append(f"Sources and licences: licence {token} not stated")

    # Every idea id from the research notes is accounted for somewhere in the plan.
    ids = []
    for f in sorted((REPO / "docs" / "research").glob("*.json")):
        try:
            ids += [i["id"] for i in json.loads(f.read_text()).get("best_ideas", []) if "id" in i]
        except (json.JSONDecodeError, TypeError, KeyError):
            errs.append(f"cannot read idea ids from {f.name}")
    absent = [i for i in ids if i not in text]
    if not ids:
        errs.append("no research idea ids found in docs/research/*.json")
    if absent:
        errs.append(f"{len(absent)} of {len(ids)} research idea ids not accounted for, e.g. {absent[:5]}")

    # Roadmap: at least three phases, each with a 'Done when' check.
    road = section(text, "Roadmap")
    phases = re.split(r"^### ", road, flags=re.M)[1:]
    phase_heads = [p for p in phases if re.match(r"(Phase|Milestone)\b", p)]
    if len(phase_heads) < 3:
        errs.append(f"Roadmap has {len(phase_heads)} '### Phase' subsections, need >= 3")
    for p in phase_heads:
        title = p.splitlines()[0].strip()
        if not re.search(r"done when", p, flags=re.I):
            errs.append(f"Roadmap '{title}': no 'Done when' check")

    decisions = re.findall(r"^\s*(?:[-*]|\d+\.)\s+\S", section(text, "Open decisions"), flags=re.M)
    if len(decisions) < 3:
        errs.append(f"Open decisions lists {len(decisions)} items, need >= 3")

    for e in errs:
        print(e)
    if errs:
        print(f"FAIL {len(errs)} problems")
        return 1
    print(f"OK plan: {words} words, {len(seen)} areas, {len(ids)} ideas accounted for")
    return 0


if __name__ == "__main__":
    sys.exit(main())
