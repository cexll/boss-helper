#!/usr/bin/env node
// scripts/check-lockfile-consistency.mjs — lockfile must not change without its manifest.
//
//   usage: check-lockfile-consistency.mjs <base-sha>
//
// A `bun.lock` diff without a `package.json` diff usually means a raw update command
// or a mismatched tool version — an unreviewed dependency-resolution change.
// Escape hatch: the 'lockfile-refresh' PR label (justification required in description).
// Exit: 0 consistent / 1 drift found / 2 usage.

import { REPO_ROOT, run } from './gates-lib.mjs'

const base = process.argv[2]
if (!base) {
  process.stderr.write('usage: check-lockfile-consistency.mjs <base-sha>\n')
  process.exit(2)
}
const v = run('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
if (v.code !== 0) {
  process.stderr.write(`check-lockfile: base '${base}' does not resolve locally (fetch it first)\n`)
  process.exit(2)
}
const changed = run('git', ['diff', '--name-only', `${base}...HEAD`])
  .stdout.split('\n')
  .filter(Boolean)
const has = (f) => changed.includes(f)

const pairs = [['bun.lock', 'package.json']]
const drift = pairs.filter(([lock, manifest]) => has(lock) && !has(manifest))
if (drift.length > 0) {
  for (const [lock, manifest] of drift) {
    process.stderr.write(
      `check-lockfile: FAIL — ${lock} changed but ${manifest} did not.\n` +
        '  Lockfile-only changes are unreviewed dependency-resolution drift (raw update\n' +
        '  command, mismatched tool version). Revert the lockfile, or if this is an\n' +
        "  intentional refresh (security advisory, lockfile repair), add the 'lockfile-refresh'\n" +
        '  label and a justification in the PR description.\n',
    )
  }
  process.exit(1)
}
process.stdout.write(
  `check-lockfile: PASS — ${changed.length} changed file(s); no lockfile/manifest drift (bun.lock ↔ package.json)\n`,
)
