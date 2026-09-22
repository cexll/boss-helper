#!/usr/bin/env bash
# scripts/test-guardrails.sh — proves each wired guard actually rejects what it
# claims to reject. Creates one violation per guard in a throwaway worktree and
# asserts the guard EXITS NON-ZERO *and names the reason*. Exit 126/127 (missing
# tool, non-executable hook) counts as FAIL — "not runnable" is phantom enforcement.
# Clean-state acceptance is asserted FIRST (an always-failing guard would pass a
# rejection-only self-test).
#
# Gate-level self-proofs (coverage/CRAP/baseline 5-state) live in scripts/test-gates.mjs.
# Wired: `bun run test:guardrails` (and weekly CI job harness-maintenance.yml).
set -u

repo_root="$(git rev-parse --show-toplevel)" || exit 1
tmp="$(mktemp -d "${TMPDIR:-/tmp}/guardrails.XXXXXX")"
wt="$tmp/wt"

cleanup() {
  cd "$repo_root" || exit 1
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$repo_root" worktree add --quiet --detach "$wt" || {
  echo "FATAL: could not create temp worktree (need at least one commit)" >&2
  exit 1
}
cd "$wt" || exit 1
# Uncommitted harness state: the worktree is built from HEAD, so freshly written
# guard files (.git-hooks/*) are absent until committed. Copy them in so the
# self-test measures the real guards, not the commit status. Remove once committed.
for guard in .git-hooks/check-naming.sh .git-hooks/commit-msg .git-hooks/test-naming.sh; do
  if [ ! -f "$guard" ] && [ -f "$repo_root/$guard" ]; then
    mkdir -p "$(dirname "$guard")"
    cp "$repo_root/$guard" "$guard"
  fi
done

pass=0
fail=0

expect_reject() {
  name="$1"
  reason="$2"
  shift 2
  out=$("$@" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL  $name — guard ACCEPTED the violation (phantom enforcement)"
    fail=$((fail + 1))
  elif [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    echo "FAIL  $name — guard not runnable (exit $rc): missing tool or non-executable hook"
    fail=$((fail + 1))
  elif ! printf '%s\n' "$out" | grep -qF -- "$reason"; then
    echo "FAIL  $name — exited $rc without naming \"$reason\" — crash, not rejection:"
    printf '%s\n' "$out" | sed 's/^/        /'
    fail=$((fail + 1))
  else
    echo "PASS  $name — guard rejected the violation and named it (exit $rc)"
    pass=$((pass + 1))
  fi
}

expect_accept() {
  name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $name — guard accepts the clean tree"
    pass=$((pass + 1))
  else
    echo "FAIL  $name — guard REJECTED the clean tree (always-failing guard or broken setup)"
    echo "      (expected if the repo baseline is intentionally non-green: this guard measures hooks, not repo debt)"
    fail=$((fail + 1))
  fi
}

skip() {
  echo "SKIP  $1 — $2 (a skipped guard is a readiness gap, not a pass)"
}

# 0. Clean-state baseline
expect_accept "naming guard (clean tree)" bash .git-hooks/check-naming.sh

# 1. Naming guard — forbidden suffix.
echo "guardrail self-test" > "foo_v2.ts"
git add "foo_v2.ts"
expect_reject "naming guard (foo_v2.ts)" "forbidden naming suffix" \
  bash .git-hooks/check-naming.sh
git reset --quiet -- "foo_v2.ts"
rm -f "foo_v2.ts"

# 2. Scratchpad guard — forbidden directory.
mkdir -p scratch
echo "guardrail self-test" > scratch/note.txt
git add scratch/note.txt
expect_reject "scratchpad guard (scratch/)" "scratchpad directory" \
  bash .git-hooks/check-naming.sh
git reset --quiet -- scratch/note.txt
rm -rf scratch

# 3. Commit-message guard — non-conventional message.
badmsg="$tmp/badmsg"
echo "bad message" > "$badmsg"
if [ -f .git-hooks/commit-msg ]; then
  expect_reject "commit-msg guard (\"bad message\")" "Conventional Commits" \
    bash .git-hooks/commit-msg "$badmsg"
  goodmsg="$tmp/goodmsg"
  echo "fix(harness): accept a conventional subject" > "$goodmsg"
  if bash .git-hooks/commit-msg "$goodmsg" >/dev/null 2>&1; then
    echo "PASS  commit-msg guard accepts a conventional subject"
    pass=$((pass + 1))
  else
    echo "FAIL  commit-msg guard rejected a valid conventional subject"
    fail=$((fail + 1))
  fi
  # 3b. gitmoji-prefixed conventional subject (repo convention) must be accepted
  emoji="$tmp/emojmsg"
  echo "✨ feat(chat): 添加WebSocket聊天功能" > "$emoji"
  if bash .git-hooks/commit-msg "$emoji" >/dev/null 2>&1; then
    echo "PASS  commit-msg guard accepts gitmoji-prefixed conventional subject"
    pass=$((pass + 1))
  else
    echo "FAIL  commit-msg guard rejected the repo's own gitmoji history style"
    fail=$((fail + 1))
  fi
else
  skip "commit-msg guard" "no commit-msg hook found"
fi

echo
echo "guardrail self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
