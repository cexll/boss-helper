#!/usr/bin/env bash
# .git-hooks/test-naming.sh — self-proof for check-naming.sh (dual assertion).
# Asserts BOTH directions:
#   1. the guard accepts a clean tree (an always-failing guard would pass a
#      rejection-only test)
#   2. the guard exits non-zero AND names the reason for each staged violation
# Runs entirely in a throwaway worktree; never touches the user's tree.
#
# Wired into scripts/test-guardrails.sh and runnable standalone.
set -euo pipefail

repo_root="$(git -C "$(pwd)" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "FATAL: not inside a git repository" >&2
  exit 1
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/naming-selftest.XXXXXX")"
wt="$tmp/wt"
cleanup() {
  cd / >/dev/null 2>&1 || true
  git -C "$repo_root" worktree remove --force "$wt" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$repo_root" worktree add --quiet --detach "$wt" || {
  echo "FATAL: could not create temp worktree (need at least one commit)" >&2
  exit 1
}
cd "$wt"

# The worktree checks out HEAD; uncommitted harness files (guards written this
# session, constraints.yaml) are not in HEAD yet. Copy the CURRENT versions in so
# the self-test measures the real guards, not the commit status.
if [ ! -f .git-hooks/check-naming.sh ] && [ -f "$repo_root/.git-hooks/check-naming.sh" ]; then
  mkdir -p .git-hooks
  cp "$repo_root/.git-hooks/check-naming.sh" .git-hooks/check-naming.sh
fi
[ -f constraints.yaml ] || [ ! -f "$repo_root/constraints.yaml" ] || cp "$repo_root/constraints.yaml" constraints.yaml

fail=0

# 1. clean tree must be accepted
if bash .git-hooks/check-naming.sh >/dev/null 2>&1; then
  echo "PASS  naming guard accepts clean tree"
else
  echo "FAIL  naming guard rejected the clean tree (always-failing guard?)"
  fail=1
fi

# 2. forbidden suffix must be rejected AND named
echo "selftest" > foo_v2.ts
git add foo_v2.ts
out="$(bash .git-hooks/check-naming.sh 2>&1 || true)"
rc_out="$(bash .git-hooks/check-naming.sh >/dev/null 2>&1; echo "rc=$?")"
if printf '%s' "$out" | grep -q "forbidden naming suffix" && [ "$rc_out" != "rc=0" ]; then
  echo "PASS  naming guard rejects foo_v2.ts and names it ($rc_out)"
else
  echo "FAIL  naming guard did not reject foo_v2.ts (phantom enforcement)"
  fail=1
fi
git reset --quiet -- foo_v2.ts
rm -f foo_v2.ts

# 3. scratchpad directory must be rejected AND named
mkdir -p scratch && echo "selftest" > scratch/note.txt
git add scratch/note.txt
out="$(bash .git-hooks/check-naming.sh 2>&1 || true)"
rc_out="$(bash .git-hooks/check-naming.sh >/dev/null 2>&1; echo "rc=$?")"
if printf '%s' "$out" | grep -q "scratchpad directory" && [ "$rc_out" != "rc=0" ]; then
  echo "PASS  naming guard rejects scratch/ and names it ($rc_out)"
else
  echo "FAIL  naming guard did not reject scratch/ (phantom enforcement)"
  fail=1
fi
git reset --quiet -- scratch/note.txt
rm -rf scratch

exit "$fail"
