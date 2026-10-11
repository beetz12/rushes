#!/usr/bin/env python3
"""Score a goal-loop rubric with Kimi K3, a non-Claude model family, read-only.

Usage:
  score_kimi.py --prompt-file PROMPT.txt --out SCORE.json --add-dir DIR [--add-dir DIR ...]
                [--model kimi-code/k3] [--timeout 2400]

Kimi runs with an agent file that allows only Read, Glob and Grep, from a
trusted working folder whose project MCP config disables every MCP server.
Writes {"score", "scale", "rationale", "model", "checker_family"} to --out.
Exit 0 on a written score, 1 on any failure (no score file is written).
Setup follows openbrain/scripts/jev/score-photos.mjs (kimiDisableMcp).
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

KIMI_HOME = Path(os.environ.get("KIMI_CODE_HOME", Path.home() / ".kimi-code"))
HOST = Path.home() / ".goal-loop" / "loom-clone" / "host" / "kimi"
SYSTEM = (
    "You are an independent reviewer. You did not write the work you are grading. "
    "Read files only; you have no write tools. Be strict: an LLM reviewer's default is to be "
    "too generous, so look for concrete defects before you look for strengths. "
    "End your reply with exactly one JSON object on its own line: "
    '{"score": <number>, "scale": <number>, "rationale": "<why, naming the biggest gaps>"}'
)


def setup() -> dict:
    cwd, skills = HOST / "cwd", HOST / "empty-skills"
    for d in (HOST, cwd, skills):
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
    names = []
    try:
        names = list(json.loads((KIMI_HOME / "mcp.json").read_text()).get("mcpServers", {}))
    except (OSError, json.JSONDecodeError):
        pass
    try:
        plugins = json.loads((KIMI_HOME / "plugins" / "installed.json").read_text()).get("plugins", [])
    except (OSError, json.JSONDecodeError):
        plugins = []
    for p in plugins:
        try:
            manifest = json.loads((Path(p["root"]) / "kimi.plugin.json").read_text())
            names += [f"plugin-{p['id']}:{s}" for s in manifest.get("mcpServers", {})]
        except (OSError, KeyError, json.JSONDecodeError):
            continue
    (cwd / ".kimi-code").mkdir(exist_ok=True, mode=0o700)
    servers = {n: {"command": "true", "enabled": False} for n in names}
    (cwd / ".kimi-code" / "mcp.json").write_text(json.dumps({"mcpServers": servers}, indent=1))
    root = os.path.realpath(cwd).rstrip("/")
    slug = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9._-]+", "-", root.split("/")[-1].lower())) or "workspace"
    trust_dir = KIMI_HOME / "workspace-trust"
    trust_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    trust = trust_dir / f"wd_{slug}_{hashlib.sha256(root.encode()).hexdigest()[:12]}"
    if not trust.exists():
        trust.write_text(json.dumps({"root": root, "trustedAt": int(time.time() * 1000)}))
        trust.chmod(0o600)
    agent = HOST / "rubric-scorer.md"
    agent.write_text(f"---\nname: rubric-scorer\ndescription: Grades a document against a rubric, read-only\n"
                     f"tools:\n  - Read\n  - Glob\n  - Grep\n---\n{SYSTEM}\n")
    return {"cwd": cwd, "skills": skills, "agent": agent}


def last_json(text: str):
    for m in reversed(list(re.finditer(r"\{[^{}]*\"score\"[^{}]*\}", text, flags=re.S))):
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--add-dir", action="append", default=[])
    ap.add_argument("--model", default="kimi-code/k3")
    ap.add_argument("--timeout", type=int, default=2400)
    args = ap.parse_args()
    s = setup()
    prompt = Path(args.prompt_file).read_text() + "\n\n" + SYSTEM
    cmd = [os.environ.get("KIMI_BIN", str(KIMI_HOME / "bin" / "kimi")), "-p", prompt, "-m", args.model,
           "--agent-file", str(s["agent"]), "--skills-dir", str(s["skills"]), "--output-format", "stream-json"]
    for d in args.add_dir:
        cmd += ["--add-dir", str(Path(d).expanduser().resolve())]
    try:
        proc = subprocess.run(cmd, cwd=s["cwd"], capture_output=True, text=True, timeout=args.timeout)
    except subprocess.TimeoutExpired:
        print(f"kimi timed out after {args.timeout}s")
        return 1
    events = []
    for line in proc.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    tools = [t.get("function", {}).get("name") for e in events for t in (e.get("tool_calls") or [])]
    answers = [e["content"] for e in events if e.get("role") == "assistant" and isinstance(e.get("content"), str) and e["content"].strip()]
    text = answers[-1] if answers else ""
    if "not trusted" in proc.stderr:
        print("warning: kimi did not trust the scorer folder; MCP servers may have started")
    verdict = last_json(text)
    if proc.returncode != 0 or not verdict or "score" not in verdict:
        print(f"kimi failed (exit {proc.returncode}); stderr tail: {proc.stderr[-400:]}; reply tail: {text[-400:]}")
        return 1
    verdict.setdefault("scale", 10)
    verdict.update({"model": args.model, "checker_family": "kimi", "tools_used": sorted(set(filter(None, tools)))})
    Path(args.out).write_text(json.dumps(verdict, indent=1))
    print(f"score {verdict['score']}/{verdict['scale']} written to {args.out}; tools used: {verdict['tools_used']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
