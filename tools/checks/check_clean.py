#!/usr/bin/env python3
"""Clean-room contamination check.

Counts runs of K consecutive word tokens in our docs that also appear in a
copyleft source file (AGPL/GPL parts of Cap, Recordly, Screenity, and better-shot's copyleft_paths) and do NOT
appear in any permissive source (so shared public-API boilerplate is ignored).

Usage: check_clean.py [--k 12] PATH [PATH ...]   (files or directories)
First output line is the hit count (the loop's metric; must be 0). Each hit is
then listed as 'doc:line <- source-path'. The matched text is never printed.
Run with python3 -I.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import SOURCES, clone_dir, is_permissive_path  # noqa: E402

TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+")
DOC_EXT = {".md", ".json", ".txt"}
SRC_EXT = {".swift", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".m", ".mm",
           ".h", ".c", ".cc", ".cpp", ".go", ".kt", ".java", ".css", ".scss", ".html", ".vue",
           ".svelte", ".md", ".mdx", ".json", ".toml", ".yaml", ".yml", ".txt", ".sh", ".sql"}
SKIP_NAMES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "bun.lock"}
SKIP_DIRS = {"node_modules", "dist", "build", ".next", "target"}
MAX_BYTES = 2_000_000


def tokens_with_lines(text: str):
    out = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for m in TOKEN.finditer(line):
            out.append((m.group(0).lower(), lineno))
    return out


def doc_files(paths):
    for p in map(Path, paths):
        if p.is_dir():
            yield from (f for f in sorted(p.rglob("*")) if f.is_file() and f.suffix in DOC_EXT)
        elif p.is_file():
            yield p


def source_files(slug: str, want_permissive: bool):
    root = clone_dir(slug)
    listed = subprocess.run(["git", "-C", str(root), "ls-files"], capture_output=True, text=True).stdout.splitlines()
    for rel in listed:
        parts = rel.split("/")
        name = parts[-1]
        if name in SKIP_NAMES or name.upper().startswith(("LICENSE", "LICENCE", "COPYING")):
            continue
        if any(d in SKIP_DIRS for d in parts[:-1]) or name.endswith((".min.js", ".map")):
            continue
        if Path(name).suffix not in SRC_EXT:
            continue
        if is_permissive_path(slug, rel) != want_permissive:
            continue
        f = root / rel
        try:
            if f.stat().st_size > MAX_BYTES:
                continue
            yield rel, f.read_text(errors="ignore")
        except OSError:
            continue


def scan(text: str, k: int, keys: dict, firsts: set):
    toks = [t for t, _ in tokens_with_lines(text)]
    for i in range(len(toks) - k + 1):
        if toks[i] not in firsts:
            continue
        key = " ".join(toks[i:i + k])
        if key in keys:
            yield key


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("paths", nargs="+")
    args = ap.parse_args()
    k = args.k

    doc_keys: dict = {}
    for f in doc_files(args.paths):
        tl = tokens_with_lines(f.read_text(errors="ignore"))
        for i in range(len(tl) - k + 1):
            key = " ".join(t for t, _ in tl[i:i + k])
            doc_keys.setdefault(key, (str(f), tl[i][1]))
    firsts = {key.split(" ", 1)[0] for key in doc_keys}

    hits: dict = {}
    for slug, src in SOURCES.items():
        if src["class"] != "copyleft" and not src.get("copyleft_paths"):
            continue
        for rel, text in source_files(slug, want_permissive=False):
            for key in scan(text, k, doc_keys, firsts):
                hits.setdefault(key, f"{slug}:{rel}")

    if hits:
        hit_firsts = {key.split(" ", 1)[0] for key in hits}
        for slug in SOURCES:
            for _rel, text in source_files(slug, want_permissive=True):
                for key in scan(text, k, hits, hit_firsts):
                    hits.pop(key, None)
                if not hits:
                    break
            if not hits:
                break

    print(len(hits))
    for key, src in sorted(hits.items(), key=lambda kv: doc_keys[kv[0]]):
        doc, line = doc_keys[key]
        print(f"{doc}:{line} <- {src}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
