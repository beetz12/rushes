"""Shared helpers for the clean-room research checks. Standard library only."""
import fnmatch
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_CONFIG = json.loads((REPO / "tools" / "checks" / "sources.json").read_text())
REF_ROOT = Path(_CONFIG["reference_root"]).expanduser()
AREAS = list(_CONFIG["feature_areas"])
SOURCES = {s["slug"]: s for s in _CONFIG["sources"]}
REUSE_MODES = {"copy-with-notice", "clean-room", "idea-only"}

# A cited path may carry a line suffix: path:12, path:12-40 or path#L12-L40.
_LINE_SUFFIX = re.compile(r"(:\d+(-\d+)?|#L\d+(-L?\d+)?)$")


def clone_dir(slug: str) -> Path:
    return REF_ROOT / SOURCES[slug]["dir"]


def strip_suffix(path: str) -> str:
    return _LINE_SUFFIX.sub("", path.strip()).strip("/")


def path_exists(slug: str, path: str) -> bool:
    rel = strip_suffix(path)
    if not rel or rel.startswith("..") or rel.startswith("/"):
        return False
    return (clone_dir(slug) / rel).exists()


def is_permissive_path(slug: str, path: str) -> bool:
    src = SOURCES[slug]
    if src["class"] == "permissive":
        return True
    rel = strip_suffix(path)
    for pat in src["permissive_paths"]:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, pat + "/*"):
            return True
    return False


def section(text: str, heading: str) -> str:
    """Body of a '## heading' section, up to the next '## ' heading."""
    m = re.search(rf"^## {re.escape(heading)}\s*$", text, flags=re.M)
    if not m:
        return ""
    rest = text[m.end():]
    nxt = re.search(r"^## ", rest, flags=re.M)
    return rest[: nxt.start()] if nxt else rest
