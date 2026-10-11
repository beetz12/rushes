#!/usr/bin/env python3
"""Check clean-room research notes: docs/research/<slug>.md and <slug>.json.

Usage:
  check_research.py SLUG [SLUG ...]   check the named notes (both files required)
  check_research.py --present         check every slug that has either file
  check_research.py --all             require and check all nine slugs

Prints one line per failure and exits 1 if any check fails, else prints
"OK <n> notes" and exits 0. Run with python3 -I.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import AREAS, REPO, REUSE_MODES, SOURCES, clone_dir, is_permissive_path, path_exists, section  # noqa: E402

HEADINGS = ["Snapshot", "What it does", "Feature inventory", "Architecture",
            "Best ideas", "Weaknesses and gaps", "Inspected paths"]
LICENCE_TOKEN = {"CC0-1.0": "CC0", "BSD-3-Clause": "BSD-3", "MIT": "MIT"}
MIN_WORDS = 700
RESEARCH = REPO / "docs" / "research"


def min_paths(slug: str) -> int:
    root = clone_dir(slug)
    n = sum(1 for p in root.rglob("*") if p.is_file() and ".git" not in p.parts)
    return min(20, max(8, n // 25))


def check_md(slug: str, errs: list) -> None:
    src = SOURCES[slug]
    path = RESEARCH / f"{slug}.md"
    if not path.is_file():
        errs.append(f"{slug}: missing {path.relative_to(REPO)}")
        return
    text = path.read_text()
    for h in HEADINGS:
        if not re.search(rf"^## {re.escape(h)}\s*$", text, flags=re.M):
            errs.append(f"{slug}.md: missing heading '## {h}'")
    if re.search(r"^\s*(```|~~~)", text, flags=re.M):
        errs.append(f"{slug}.md: contains a fenced code block (not allowed in research notes; cite paths instead)")
    words = len(re.findall(r"\w+", text))
    if words < MIN_WORDS:
        errs.append(f"{slug}.md: {words} words, need >= {MIN_WORDS}")
    snap = section(text, "Snapshot")
    if src["sha"] not in snap:
        errs.append(f"{slug}.md: Snapshot does not state the pinned SHA {src['sha']}")
    lic = src["licence"]
    token = "AGPL" if lic.startswith("AGPL") else ("GPL" if lic.startswith("GPL") else LICENCE_TOKEN.get(lic, lic))
    if token not in snap:
        errs.append(f"{slug}.md: Snapshot does not state the licence ({token})")
    cited = re.findall(r"^\s*[-*]\s+`([^`]+)`", section(text, "Inspected paths"), flags=re.M)
    need = min_paths(slug)
    if len(cited) < need:
        errs.append(f"{slug}.md: {len(cited)} inspected paths listed, need >= {need}")
    for p in cited:
        if not path_exists(slug, p):
            errs.append(f"{slug}.md: inspected path does not exist in clone: {p}")


def check_json(slug: str, errs: list, idea_ids: set) -> None:
    src = SOURCES[slug]
    path = RESEARCH / f"{slug}.json"
    if not path.is_file():
        errs.append(f"{slug}: missing {path.relative_to(REPO)}")
        return
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        errs.append(f"{slug}.json: invalid JSON: {exc}")
        return
    for key in ("repo", "sha", "licence", "features", "best_ideas", "weaknesses"):
        if key not in data:
            errs.append(f"{slug}.json: missing key '{key}'")
    if errs and any(e.startswith(f"{slug}.json: missing key") for e in errs):
        return
    if data["repo"] != src["repo"]:
        errs.append(f"{slug}.json: repo is {data['repo']!r}, expected {src['repo']!r}")
    if not str(data["sha"]).startswith(src["sha"]):
        errs.append(f"{slug}.json: sha {data['sha']!r} does not match pinned {src['sha']}")
    feats = data["features"]
    if not isinstance(feats, dict):
        errs.append(f"{slug}.json: features must be an object keyed by area id")
        feats = {}
    for area in AREAS:
        f = feats.get(area)
        if not isinstance(f, dict):
            errs.append(f"{slug}.json: features missing area '{area}'")
            continue
        if not isinstance(f.get("present"), bool):
            errs.append(f"{slug}.json: {area}.present must be true/false")
        q = f.get("quality")
        if not isinstance(q, int) or not 0 <= q <= 5:
            errs.append(f"{slug}.json: {area}.quality must be an integer 0-5")
        if not str(f.get("summary", "")).strip():
            errs.append(f"{slug}.json: {area}.summary is empty")
        paths = f.get("paths", [])
        if f.get("present") is True and not paths:
            errs.append(f"{slug}.json: {area} is present but cites no paths")
        if f.get("present") is False and q not in (0, None):
            errs.append(f"{slug}.json: {area} is absent but quality is {q}")
        for p in paths:
            if not path_exists(slug, p):
                errs.append(f"{slug}.json: {area} path does not exist in clone: {p}")
    for area in feats:
        if area not in AREAS:
            errs.append(f"{slug}.json: unknown feature area '{area}'")
    ideas = data["best_ideas"]
    if not isinstance(ideas, list) or len(ideas) < src["min_ideas"]:
        errs.append(f"{slug}.json: need >= {src['min_ideas']} best_ideas")
        ideas = ideas if isinstance(ideas, list) else []
    for i, idea in enumerate(ideas):
        iid = str(idea.get("id", ""))
        if not re.fullmatch(rf"{re.escape(slug)}-[a-z0-9-]+", iid):
            errs.append(f"{slug}.json: best_ideas[{i}].id {iid!r} must look like '{slug}-<kebab-case>'")
        if iid in idea_ids:
            errs.append(f"{slug}.json: duplicate idea id {iid!r}")
        idea_ids.add(iid)
        for key in ("title", "what", "why"):
            if not str(idea.get(key, "")).strip():
                errs.append(f"{slug}.json: {iid}: '{key}' is empty")
        if idea.get("area") not in AREAS:
            errs.append(f"{slug}.json: {iid}: area {idea.get('area')!r} is not a known feature area")
        mode = idea.get("reuse_mode")
        if mode not in REUSE_MODES:
            errs.append(f"{slug}.json: {iid}: reuse_mode {mode!r} not in {sorted(REUSE_MODES)}")
        paths = idea.get("paths", [])
        if not paths:
            errs.append(f"{slug}.json: {iid}: cites no paths")
        for p in paths:
            if not path_exists(slug, p):
                errs.append(f"{slug}.json: {iid}: path does not exist in clone: {p}")
        if mode == "copy-with-notice" and not all(is_permissive_path(slug, p) for p in paths):
            errs.append(f"{slug}.json: {iid}: copy-with-notice cites a copyleft path; use clean-room or idea-only")
    weak = data["weaknesses"]
    if not isinstance(weak, list) or len([w for w in weak if str(w).strip()]) < 2:
        errs.append(f"{slug}.json: need >= 2 weaknesses")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("slugs", nargs="*")
    ap.add_argument("--present", action="store_true")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    if args.all:
        slugs = list(SOURCES)
    elif args.present:
        slugs = [s for s in SOURCES if (RESEARCH / f"{s}.md").exists() or (RESEARCH / f"{s}.json").exists()]
    else:
        slugs = args.slugs
    unknown = [s for s in slugs if s not in SOURCES]
    if unknown or not slugs:
        print(f"usage error: unknown or no slugs {unknown}; known: {sorted(SOURCES)}")
        return 2
    errs: list = []
    idea_ids: set = set()
    for slug in slugs:
        check_md(slug, errs)
        check_json(slug, errs, idea_ids)
    for e in errs:
        print(e)
    if errs:
        print(f"FAIL {len(errs)} problems in {len(slugs)} notes")
        return 1
    print(f"OK {len(slugs)} notes, {len(idea_ids)} ideas")
    return 0


if __name__ == "__main__":
    sys.exit(main())
