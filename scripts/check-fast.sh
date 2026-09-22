#!/usr/bin/env bash
# scripts/check-fast.sh — narrowest local evidence: scoped checks on CHANGED files only.
# Repo-wide gates (typecheck, anti-drift, baseline, full coverage) stay in `bun run check:all` / CI.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

changed=$(git diff --name-only --diff-filter=ACMR HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.vue' | tr '\n' ' ')
if [ -z "${changed// /}" ]; then
  echo "check-fast: no changed source files — nothing scoped to run (report honestly: empty by fact, not by skip)"
  exit 0
fi
echo "check-fast: files: $changed"
# format
node_modules/.bin/oxfmt --check $changed
# lint (gate rules; baseline ratchet owns the repo-wide legacy count)
node_modules/.bin/oxlint --type-aware --config .oxlintrc.gate.json $changed
# tests related to changed files (bun test with a name filter per module would over-narrow;
# run the full unit suite — it is milliseconds)
bun test
