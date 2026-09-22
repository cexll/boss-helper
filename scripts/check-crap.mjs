#!/usr/bin/env node
// scripts/check-crap.mjs — diff-scoped change-risk (CRAP) gate.
//
//   usage: check-crap.mjs [--base <ref>] [--all]
//
// Pipeline: bun test lcov -> scripts/lcov-to-linemap.mjs -> scripts/change-risk-gate.mjs
// (upstream template, verbatim copy; reads the normalized line map through its
// istanbul-shaped `data[path].lines` fallback — absence counts as unexecuted).
//
// Default scope: .ts files changed vs --base (or origin/main / HEAD~1 fallback),
// which is where a ceiling means something: new/changed code must land below
// size_limits.max_crap_score.value with its own coverage. Full-repo scan (--all)
// is advisory: 42 legacy functions sit above the ceiling at the freeze rev — the
// ceiling rises never; it falls as legacy code gets tested or simplified.

import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, fail2, run, needNumber } from './gates-lib.mjs'
const argv = process.argv.slice(2)
const args = { base: null, all: false }
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--base') args.base = argv[++i]
  else if (argv[i] === '--all') args.all = true
  else fail2(`check-crap: unknown argument ${argv[i]}`)
}
if (!args.base && process.env.CRAP_BASE) args.base = process.env.CRAP_BASE

const ceiling = needNumber(
  ['size_limits', 'max_crap_score', 'value'],
  'size_limits.max_crap_score.value',
)

// 1. fresh lcov
const covDir = '.run/coverage-crap'
const t = run('bun', [
  'test',
  '--coverage',
  '--coverage-dir',
  covDir,
  '--coverage-reporter',
  'lcov',
])
const lcov = path.join(REPO_ROOT, covDir, 'lcov.info')
if (!fs.existsSync(lcov)) {
  process.stderr.write(t.stdout + t.stderr)
  fail2(`check-crap: coverage artifact missing at ${lcov}`)
}
// 2. line map
const linemap = path.join(REPO_ROOT, covDir, 'linemap.json')
const conv = run('node', ['scripts/lcov-to-linemap.mjs', covDir + '/lcov.info', linemap])
if (conv.code !== 0) {
  process.stderr.write(conv.stdout + conv.stderr)
  fail2('check-crap: lcov->linemap adapter failed')
}

// 3. scope
let targets
if (args.all) {
  targets = ['src']
} else {
  const bases = [args.base, 'origin/main', 'HEAD~1'].filter(Boolean)
  let files = null
  for (const b of bases) {
    const v = run('git', ['rev-parse', '--verify', '--quiet', `${b}^{commit}`])
    if (v.code !== 0) continue
    const d = run('git', ['diff', '--name-only', '--diff-filter=ACMR', `${b}...HEAD`, '--', '*.ts'])
    if (d.code !== 0) continue
    files = new Set(d.stdout.split('\n').filter(Boolean))
    const w = run('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', '*.ts'])
    for (const f of w.stdout.split('\n').filter(Boolean)) files.add(f)
    const u = run('git', ['ls-files', '--others', '--exclude-standard'])
    for (const f of u.stdout.split('\n').filter((x) => x.endsWith('.ts'))) files.add(f)
    process.stdout.write(`check-crap: diff base = ${b}\n`)
    break
  }
  if (files === null)
    fail2('check-crap: no diff base resolves locally (pass --base <ref> after fetching)')
  targets = [...files].filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && fs.existsSync(path.join(REPO_ROOT, f)),
  )
  if (targets.length === 0) {
    process.stdout.write(
      'check-crap: no changed .ts files vs base — nothing in scope; PASS (scope report above, empty by fact not by skip)\n',
    )
    process.exit(0)
  }
}

// 4. run the gate per target (template accepts a file or dir via --src)
let worst = 0
for (const target of targets) {
  const r = run('node', [
    'scripts/change-risk-gate.mjs',
    '--coverage',
    linemap,
    '--ceiling',
    String(ceiling),
    '--src',
    target,
  ])
  const text = `${r.stdout}${r.stderr}`
  if (r.code === 2 || r.code === 3) {
    process.stderr.write(text)
    fail2(
      `check-crap: gate exited ${r.code} on ${target} (usage/setup error — untrusted, not a pass)`,
    )
  }
  if (r.code === 1) {
    // surface only the FAIL line for scope readability
    const fails = text
      .split('\n')
      .filter((l) => l.startsWith('FAIL') || /^\s+\d+\s+\d+.*FAIL/.test(l))
    process.stderr.write(
      `check-crap: ${target} — CRAP above ceiling ${ceiling}:\n${fails.join('\n')}\n`,
    )
    worst = 1
  } else {
    process.stdout.write(`check-crap: ${target} — PASS (ceiling ${ceiling})\n`)
  }
}
if (worst === 1) {
  process.stderr.write(
    `check-crap: FAIL — add tests covering the branches or simplify the function. Never raise size_limits.max_crap_score.value to pass.\n`,
  )
}
process.exitCode = worst
