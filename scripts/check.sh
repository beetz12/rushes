#!/bin/bash
# Build, test and run the clean-room checks. Exit non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== swift build =="
swift build

echo "== swift test =="
swift test

echo "== clean-room check on our source =="
first=$(python3 -I tools/checks/check_clean.py Sources Tests | head -1)
[ "$first" = "0" ] || { echo "check_clean reported $first"; exit 1; }

echo "== notices sync =="
missing=0
for f in $(grep -rl "Derived from" Sources Tests 2>/dev/null); do
  rel=$(basename "$f")
  grep -q "$rel" THIRD_PARTY_NOTICES.md || { echo "missing notice row: $f"; missing=1; }
done
[ "$missing" = "0" ] || exit 1

echo "OK: build, tests, clean-room and notices all pass"
