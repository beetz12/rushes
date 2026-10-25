#!/bin/bash
# Mac/native and shipped web scope. The unchanged check.sh remains the full deferred-recorder diagnostic gate.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== swift build =="
swift build

echo "== swift test =="
# A pipe fully buffers swift test, so a long suite prints nothing until it
# exits. A pty makes that output line-buffered and preserves the exit code.
# Parallel Swift Testing on the 3-core runner saturates the video encoder:
# finalize deadlines miss, and fixture writers that poll readiness never
# finish inside the job limit. One test at a time keeps those deadlines real.
python3 - <<'PY'
import os, sys
pid, fd = os.forkpty()
if pid == 0:
    try:
        os.execvp("swift", ["swift", "test", "--no-parallel"])
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
for surface in shell cloud viewer worker browser; do
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
    # Studio UI checks use Playwright Chromium rather than the installed Chrome channel.
    if [ "$surface" = "browser" ]; then
      PATH="$node_dir:$PATH" npm --prefix "$surface" exec -- playwright install chromium
    fi
    # Viewer tests launch Playwright WebKit. npm ci does not download it.
    # Chrome is the branded channel already on the runner.
    if [ "$surface" = "viewer" ]; then
      PATH="$node_dir:$PATH" npm --prefix "$surface" exec -- playwright install webkit
    fi
    PATH="$node_dir:$PATH" npm --prefix "$surface" run build
    if [ "$surface" = "browser" ]; then
      PATH="$node_dir:$PATH" npm --prefix "$surface" run test:web
    else
      PATH="$node_dir:$PATH" npm --prefix "$surface" test
    fi
    if [ "$surface" = "shell" ]; then
      PATH="$node_dir:$PATH" node --test verification/helper-process.mjs
    fi
    if [ -d "$surface/src" ]; then
      clean_paths+=("$surface/src")
    fi
  fi
done
# Packaging helpers and independent verifiers are first-party source too.
# These owned source directories exclude generated dependency/build outputs.
clean_paths+=(shell/scripts shell/tests scripts/app-intents verification .github/workflows .github/actions docs/design docs/verification)
clean_paths+=(viewer/test viewer/viewer.css scripts/check.sh scripts/check-mac-web.sh docs/PLAN.md viewer/README.md README.md browser/README.md browser/docs)
clean_paths+=(browser/test browser/index.html browser/vite.config.ts browser/tsconfig.json browser/package.json)
clean_paths+=(scripts/check-browser-recorder.mjs scripts/install-test-chrome.mjs tools/checks/check_notices.py THIRD_PARTY_NOTICES.md)

echo "== clean-room check on our source =="
python3 tools/checks/test_clean_inputs.py
clean_output=$(python3 -I tools/checks/check_clean.py "${clean_paths[@]}")
echo "$clean_output"
first=${clean_output%%$'\n'*}
[ "$first" = "0" ] || { echo "check_clean reported $first"; exit 1; }

echo "== notices sync =="
python3 tools/checks/test_notices.py
python3 -I tools/checks/check_notices.py

echo "== independent verifier self-checks =="
verifier_node_pin=$(tr -d '[:space:]' < shell/.nvmrc)
verifier_node_pin=${verifier_node_pin#v}
"$HOME/.nvm/versions/node/v$verifier_node_pin/bin/node" --test verification/recording-acceptance/*.test.mjs verification/update-acceptance/*.test.mjs
python3 -m unittest discover -s verification -p 'test_*.py'

echo "OK: build, tests, clean-room and notices all pass"
