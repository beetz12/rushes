#!/bin/sh
# Integration gate for the reader stage: all nine notes valid, zero copyleft overlap.
cd "$(dirname "$0")/../.." || exit 2
python3 -I tools/checks/check_research.py --all || exit 1
out=$(python3 -I tools/checks/check_clean.py docs) || exit 1
hits=$(printf '%s\n' "$out" | head -1)
echo "contamination hits: $hits"
[ "$hits" = "0" ] || { printf '%s\n' "$out" | tail -n +2 | head -40; exit 1; }
