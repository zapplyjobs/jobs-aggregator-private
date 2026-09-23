#!/usr/bin/env bash
# AGG-PIN-ANCESTOR-GUARD-1 (2026-09-22): block submodule-pin defects on landing.
# Designed from a full-history dry run (862 gitlink transitions, 520
# SHA-claiming commits replayed); catches both observed defect classes:
#   (a) MESSAGE-TREE AGREEMENT: if the HEAD commit mentions hex SHA(s), the
#       tree's pin must match at least one of them. Catches the A294 incident
#       class - a "bump to X" commit whose tree still pins the older SHA
#       (09bfdd06: message claimed 8f42f67, tree kept 639abacd; the stale-index
#       no-op bump that left the pin 62h behind engine main).
#   (b) ANCESTRY: the new pin must not be an ANCESTOR of the previous pin
#       (silent backward pins - >=10 historical instances). Escape:
#       [pin-rollback-ok] in the HEAD message (acknowledged rollback).
#   (c) ORPHAN: a mentioned pin that cannot be resolved on the engine remote
#       is a fail (bumping to an unmerged branch SHA).
#   PASS cases: pin hold; forward advance; amend/rebase pairs (neither is the
#   other's ancestor); messages without any hex SHA (non-bump commits).
# Runs after checkout; HEAD~1 must exist (gate checkout uses fetch-depth: 2).
# SUBMODULE_DIR overrides the engine-objects location for local runs (defaults
# to the in-repo submodule path).
set -euo pipefail
PIN_PATH=".github/scripts/aggregator"
SUBMODULE_DIR="${SUBMODULE_DIR:-$PWD/$PIN_PATH}"
EGIT="git --git-dir=$SUBMODULE_DIR/.git"

fail() { echo "::error::$1"; exit 1; }

OLD=$(git ls-tree HEAD~1 -- "$PIN_PATH" | awk '{print $3}')
NEW=$(git ls-tree HEAD -- "$PIN_PATH" | awk '{print $3}')
[ -z "$NEW" ] && { echo "PASS: pin absent from this commit (not a pin change)"; exit 0; }
[ "$OLD" = "$NEW" ] && { echo "PASS: pin hold at ${NEW:0:8}"; exit 0; }
MSG=$(git log -1 --pretty=%B)

# (a) message-tree agreement: resolve every mentioned SHA; the tree pin must
# match at least one (full-SHA mentions match by prefix; 7-char claims are
# expanded on the engine remote).
if echo "$MSG" | grep -qE '\b[0-9a-f]{7,40}\b'; then
  MATCH=0
  RESOLVED_ANY=0
  for claimed in $(echo "$MSG" | grep -oE '\b[0-9a-f]{40}\b' | sort -u); do
    RESOLVED_ANY=1
    FULL=$( $EGIT rev-parse --verify --quiet "$claimed" || true)
    if [ -n "$FULL" ] && [ "$NEW" = "$FULL" ]; then MATCH=1; fi
  done
  for claimed in $(echo "$MSG" | grep -oE '\b[0-9a-f]{7,39}\b' | sort -u); do
    FULL=$( $EGIT rev-parse --verify --quiet "$claimed" || true)
    if [ -n "$FULL" ]; then
      RESOLVED_ANY=1
      [ "$NEW" = "$FULL" ] && MATCH=1
    fi
  done
  [ "$RESOLVED_ANY" = "1" ] && [ "$MATCH" = "0" ] && fail "Pin/message mismatch: commit mentions engine SHA(s) but the tree pins ${NEW:0:8}. Fix the pin (bump to the intended commit) or remove the stale SHA from the message."
fi

# (b) ancestry: block silent backward pins unless acknowledged.
if [ -n "$OLD" ] && [ "$OLD" != "$NEW" ]; then
  git --git-dir="$SUBMODULE_DIR/.git" fetch origin "$OLD" "$NEW" >/dev/null 2>&1 || {
    fail "Cannot resolve pins on the engine remote: old=${OLD:0:8} new=${NEW:0:8}. Is the new pin merged to job-board-aggregator main?"
  }
  if git --git-dir="$SUBMODULE_DIR/.git" merge-base --is-ancestor "$NEW" "$OLD"; then
    if echo "$MSG" | grep -q '\[pin-rollback-ok\]'; then
      echo "PASS: acknowledged pin rollback to ${NEW:0:8} ([pin-rollback-ok])"
      exit 0
    fi
    fail "Submodule pin REGRESSION: ${NEW:0:8} is an ancestor of the current pin ${OLD:0:8}. Bump forward, or add [pin-rollback-ok] to acknowledge an intentional rollback."
  fi
fi
echo "PASS: pin ${NEW:0:8} (no defect detected)"
