#!/bin/bash
# Build, test and run the clean-room checks. Exit non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== swift build =="
swift build

echo "== swift test =="
swift test

echo "== clean-room check on our source =="
python3 tools/checks/test_clean_inputs.py
clean_output=$(python3 -I tools/checks/check_clean.py Sources Tests)
echo "$clean_output"
first=${clean_output%%$'\n'*}
[ "$first" = "0" ] || { echo "check_clean reported $first"; exit 1; }

echo "== notices sync =="
python3 tools/checks/test_notices.py
python3 -I tools/checks/check_notices.py

echo "OK: build, tests, clean-room and notices all pass"
