#!/usr/bin/env bash
# Parent-repo test runner — runs the SAME .github/scripts/__tests__/*.test.js suite the
# CI gate runs. Single source of truth: the gate (gate.yml) + the pre-push hook both call
# this, so local verification matches CI exactly. Prevents the red-gate blind spot (INF-CI-8:
# sessions ran `npm test` (submodule, 508 assertions) which passed, but never ran these 16
# parent-repo tests that the gate checks — so the gate was red for days unnoticed).
#
# Usage: bash .github/scripts/test.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
for f in .github/scripts/__tests__/*.test.js; do
  if node "$f" > /dev/null 2>&1; then
    echo "✓ $(basename "$f")"
  else
    echo "✗ $(basename "$f")"
    fail=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo "FAIL: one or more parent-repo tests failed. Fix before pushing."
  exit 1
fi
echo "✓ All parent-repo tests pass (matches gate)."
