#!/bin/bash
# Build, test and run the clean-room checks. Exit non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== swift build =="
swift build

echo "== swift test =="
# A pipe fully buffers swift test, so a long suite prints nothing until it
# exits. A pty makes that output line-buffered and preserves the exit code.
python3 - <<'PY'
import os, sys
pid, fd = os.forkpty()
if pid == 0:
    try:
        os.execvp("swift", ["swift", "test"])
    except OSError as error:
        sys.stderr.write(f"swift test failed to start: {error}\n")
        os._exit(127)
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    os.write(sys.stdout.buffer.fileno(), chunk)
    sys.stdout.buffer.flush()
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
PY

clean_paths=(Sources Tests)
for surface in shell cloud viewer worker; do
  if [ -f "$surface/package.json" ]; then
    if [ ! -f "$surface/.nvmrc" ]; then
      echo "Missing pinned Node runtime: $surface/.nvmrc" >&2
      exit 1
    fi
    node_pin=$(tr -d '[:space:]' < "$surface/.nvmrc")
    node_pin=${node_pin#v}
    node_dir="$HOME/.nvm/versions/node/v$node_pin/bin"
    if [ ! -x "$node_dir/node" ]; then
      echo "Install Node $node_pin declared by $surface/.nvmrc before running this gate" >&2
      exit 1
    fi
    echo "== $surface: Node $node_pin install/build/tests =="
    PATH="$node_dir:$PATH" npm --prefix "$surface" ci --no-audit --no-fund
    PATH="$node_dir:$PATH" npm --prefix "$surface" run build
    PATH="$node_dir:$PATH" npm --prefix "$surface" test
    if [ -d "$surface/src" ]; then
      clean_paths+=("$surface/src")
    fi
  fi
done

echo "== clean-room check on our source =="
python3 tools/checks/test_clean_inputs.py
clean_output=$(python3 -I tools/checks/check_clean.py "${clean_paths[@]}")
echo "$clean_output"
first=${clean_output%%$'\n'*}
[ "$first" = "0" ] || { echo "check_clean reported $first"; exit 1; }

echo "== notices sync =="
python3 tools/checks/test_notices.py
python3 -I tools/checks/check_notices.py

echo "OK: build, tests, clean-room and notices all pass"
