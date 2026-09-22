#!/usr/bin/env node
// scripts/check-baseline.mjs — the single violation-ratchet mechanism (Q1.4b freeze-baseline).
//
//   usage: check-baseline.mjs            # compare: CI + pre-push mode
//          check-baseline.mjs --record   # local, human-reviewed: write .baseline/findings.json
//                                        #   and sync constraints.yaml baseline.counts
//
// Measures every gate lane (lint:strict, typecheck, format, dead-code, duplicate,
// coverage-legacy), normalizes findings to (kind, file) tuple counts, and compares
// against .baseline/findings.json:
//   * NEW tuple key, or count INCREASE on an existing key        -> exit 1 (names each)
//   * total COUNT increase on any ratcheted lane                 -> exit 1
//   * DECREASE present vs committed ceilings                     -> exit 1 (lower the
//     ceiling in the same PR — a loose ceiling silently refills)
//   * a lane's tool crashes / reports unparseable output         -> exit 2 (fail closed)
// Raw validator text is echoed; the ratchet never hides a failing lane.

import fs from 'node:fs'
import path from 'node:path'

import { parseLcov } from './coverage-lib.mjs'
import { REPO_ROOT, fail2, run, tupleFromGithubLine, tupleKey, readBaseline } from './gates-lib.mjs'

const record = process.argv.includes('--record')
const BASELINE_FILE = '.baseline/findings.json'
const CONSTRAINTS = path.join(REPO_ROOT, 'constraints.yaml')

// ── lanes ───────────────────────────────────────────────────────────────────

function srcTsFiles() {
  const out = []
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (
          ['node_modules', '.git', '.wxt', '.output', '.run'].includes(ent.name) ||
          ent.name.startsWith('.')
        )
          continue
        walk(r)
      } else if (r.endsWith('.ts') && !r.endsWith('.d.ts') && !r.endsWith('.test.ts')) out.push(r)
    }
  }
  walk('src')
  return out.sort()
}

function lintLane() {
  const r = run('bun', ['run', '--silent', 'lint:strict', '--', '-f', 'github'])
  if (![0, 1].includes(r.code)) {
    process.stderr.write(r.stdout + r.stderr)
    fail2(
      `lint:strict exited ${r.code} (tool/config failure, not a violation) — fix before trusting the lane`,
    )
  }
  const tuples = []
  for (const line of r.stdout.split('\n')) {
    const t = tupleFromGithubLine(line)
    if (t) tuples.push({ kind: t.kind, file: t.file })
  }
  if (r.code === 1 && tuples.length === 0) {
    process.stderr.write(r.stdout + r.stderr)
    fail2('lint:strict reported errors but zero parseable findings — parser drift, lane untrusted')
  }
  return tuples
}

function typecheckLane() {
  const r = run('bun', ['run', '--silent', 'check'])
  if (![0, 1, 2].includes(r.code)) {
    process.stderr.write(r.stdout + r.stderr)
    fail2(`check (vue-tsc) exited ${r.code} unexpectedly`)
  }
  const tuples = []
  for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+):/)
    if (m) tuples.push({ kind: `typecheck:${m[2]}`, file: m[1] })
  }
  if (r.code !== 0 && tuples.length === 0) {
    fail2('vue-tsc reported failure but zero parseable errors — parser drift, lane untrusted')
  }
  if (r.code === 0 && tuples.length > 0) {
    fail2('vue-tsc exited clean while emitting error lines — contradictory lane output, untrusted')
  }
  return tuples
}

function formatLane() {
  const r = run('bun', ['run', '--silent', 'fmt:check'])
  if (![0, 1].includes(r.code)) {
    process.stderr.write(r.stdout + r.stderr)
    fail2(`fmt:check exited ${r.code} unexpectedly`)
  }
  const tuples = []
  for (const raw of `${r.stdout}\n${r.stderr}`.split('\n')) {
    const m =
      raw.trim().match(/^(.+ \[[\w.]+\]) \((\d+)ms\)$/) ||
      raw.trim().match(/^(.+?\.(?:ts|tsx|js|jsx|mjs|cjs|vue|css|json|md|html)) \((\d+)ms\)$/)
    if (m && fs.existsSync(path.join(REPO_ROOT, m[1]))) {
      tuples.push({ kind: 'format', file: m[1] })
    }
  }
  if (r.code !== 0 && tuples.length === 0) {
    fail2('oxfmt reported issues but zero parseable file lines — parser drift, lane untrusted')
  }
  return tuples
}

function deadLane() {
  const r = run('bun', ['x', 'knip', '--reporter', 'compact', '--no-progress'])
  if (r.code > 3) {
    process.stderr.write(r.stdout + r.stderr)
    fail2(`knip exited ${r.code} unexpectedly`)
  }
  const lines = r.stdout.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('('))
  const tuples = []
  let cat = null
  for (const line of lines) {
    const head = line.match(/^([A-Z][A-Za-z ]+) \((\d+)\)$/)
    if (head) {
      cat = `dead:${head[1].toLowerCase().replace(/[^a-z]+/g, '-')}`
      continue
    }
    if (!cat) continue
    const file = line.split(':')[0].trim()
    if (file && file.includes('.')) tuples.push({ kind: cat, file })
  }
  // one tuple per (category, file): the ratchet tracks sprawl, not symbol count
  const seen = new Set()
  return tuples.filter((t) => {
    const k = tupleKey(t)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function duplicateLane() {
  const r = run('bun', ['x', 'jscpd', '--config', 'jscpd.json'])
  if (![0, 1].includes(r.code)) {
    process.stderr.write(r.stdout + r.stderr)
    fail2(`jscpd exited ${r.code} unexpectedly`)
  }
  const reportPath = path.join(REPO_ROOT, '.run/jscpd/jscpd-report.json')
  if (!fs.existsSync(reportPath))
    fail2('jscpd JSON report missing — reporter config broken (fail closed)')
  let rep
  try {
    rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch (e) {
    fail2(`jscpd report unreadable: ${e.message}`)
  }
  const t = rep?.statistics?.total
  if (!t || typeof t.clones !== 'number')
    fail2('jscpd report lacks statistics.total.clones — lane untrusted')
  return { clones: t.clones, percent: t.percentage }
}

function coverageLane() {
  const dir = '.run/coverage-baseline'
  const r = run('bun', ['test', '--coverage', '--coverage-dir', dir, '--coverage-reporter', 'lcov'])
  const lcovPath = path.join(REPO_ROOT, dir, 'lcov.info')
  if (!fs.existsSync(lcovPath)) {
    process.stderr.write(r.stdout + r.stderr)
    fail2(`coverage artifact missing at ${lcovPath} after \`bun test --coverage\``)
  }
  let records
  try {
    records = parseLcov(fs.readFileSync(lcovPath, 'utf8'))
  } catch (e) {
    fail2(`coverage artifact unparseable: ${e.message}`)
  }
  const all = srcTsFiles()
  if (all.length === 0)
    fail2('check-baseline: zero .ts source files found under src/ — scan broken')
  const untested = all.filter((f) => !records[f])
  return { untested }
}

// ── assemble ────────────────────────────────────────────────────────────────

process.stdout.write(
  'check-baseline: measuring lanes… lint / typecheck / format / dead-code / duplicate / coverage\n',
)
const lint = lintLane()
const typecheck = typecheckLane()
const format = formatLane()
const dead = deadLane()
const dup = duplicateLane()
const cov = coverageLane()
const tuples = [...lint, ...typecheck, ...format, ...dead]

const tupleMap = {}
for (const t of tuples) {
  const k = tupleKey(t)
  tupleMap[k] = (tupleMap[k] ?? 0) + 1
}

const counts = {
  lint_findings: lint.length,
  typecheck_errors: typecheck.length,
  format_violations: format.length,
  duplicate_code: dup.clones,
  dead_code: dead.length,
  size_violations: lint.filter((t) => /max-lines|complexity/.test(t.kind)).length,
  legacy_untested_count: cov.untested.length,
}

if (record) {
  const head = run('git', ['rev-parse', 'HEAD'])
  const dirty = run('git', ['status', '--porcelain'])
  const data = {
    rev: head.stdout.trim(),
    rev_note:
      'counts were measured in the working tree at this commit' +
      (dirty.stdout.trim() ? ' (tree dirty — includes uncommitted edits)' : ' (tree clean)'),
    frozen_on: new Date().toISOString().slice(0, 10),
    counts,
    tuples: tupleMap,
    legacyUntested: cov.untested,
  }
  const out = path.join(REPO_ROOT, BASELINE_FILE)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`)
  syncConstraints(counts, cov.untested)
  process.stdout.write(
    `check-baseline: RECORDED ${Object.keys(tupleMap).length} tuple keys, totals ${JSON.stringify(counts)}\n  -> ${BASELINE_FILE} (+ constraints.yaml baseline.counts)\n`,
  )
  process.exitCode = 0
} else {
  const base = readBaseline(BASELINE_FILE)
  const errors = []
  for (const [key, cur] of Object.entries(tupleMap)) {
    const allowed = base.tuples[key] ?? 0
    if (cur > allowed) {
      const [kind, file] = key.split('\u0000')
      errors.push(
        `NEW/INCREASED finding tuple  lint/tuple ${kind} @ ${file}: ${allowed} -> ${cur}  (fix the new violation; do not raise the ceiling)`,
      )
    }
  }
  for (const [lane, cur] of Object.entries(counts)) {
    const allowed = base.counts[lane]
    if (allowed === undefined) {
      errors.push(
        `baseline has no ceiling for lane "${lane}" — constraints.yaml/baseline drift; re-run harness-init repair`,
      )
    } else if (cur > allowed) {
      errors.push(
        `lane ${lane}: baseline ceiling ${allowed} -> now ${cur}  (increase fails the ratchet)`,
      )
    } else if (cur < allowed) {
      errors.push(
        `lane ${lane}: dropped ${allowed} -> ${cur} — LOWER the ceiling in this PR: \`bun run check:baseline --record\` and commit .baseline/findings.json + constraints.yaml`,
      )
    }
  }
  const newUntested = cov.untested.filter((f) => !base.legacyUntested.includes(f))
  if (newUntested.length > 0) {
    errors.push(
      `untested .ts file(s) not in the frozen legacy set — test them or (legacy only) re-record with justification:\n    ${newUntested.join('\n    ')}`,
    )
  }
  if (errors.length > 0) {
    process.stderr.write(`check-baseline: FAIL (${errors.length})\n`)
    for (const e of errors) process.stderr.write(`  ${e}\n`)
    process.stderr.write(
      'Why: legacy violations are frozen ceilings; new and changed code meets the 一般配置 gates in full. Raising a ceiling = profile downgrade (explicit user confirmation + strictness ledger).\n',
    )
    process.exitCode = 1
  } else {
    process.stdout.write(
      `check-baseline: PASS — ${Object.keys(tupleMap).length} tuple keys within ceilings; totals ${JSON.stringify(counts)}\n`,
    )
    process.exitCode = 0
  }
}

// ── constraints.yaml sync (record only) ─────────────────────────────────────

function syncConstraints(nextCounts, untested) {
  const text = fs.readFileSync(CONSTRAINTS, 'utf8')
  const lines = text.split('\n')
  for (const [lane, val] of Object.entries(nextCounts)) {
    const idx = lines.findIndex((l) => new RegExp(`^    ${lane}: \\d+`).test(l))
    if (idx === -1)
      fail2(
        `sync: constraints.yaml baseline.counts.${lane} row not found — restore the template row`,
      )
    lines[idx] = lines[idx].replace(/^    (\w+): \d+/, `    $1: ${val}`)
  }
  const li = lines.findIndex((l) => l.trim().startsWith('legacy_untested_files:'))
  if (li === -1) fail2('sync: constraints.yaml baseline.legacy_untested_files row not found')
  // drop any previous sequence rows, then write a block sequence (formatter-stable)
  let end = li + 1
  while (end < lines.length && /^\s{4}-\s/.test(lines[end])) end += 1
  const body =
    untested.length === 0
      ? ['  legacy_untested_files: []']
      : ['  legacy_untested_files:', ...untested.map((f) => `    - ${f}`)]
  lines.splice(li, end - li, ...body)
  fs.writeFileSync(CONSTRAINTS, `${lines.join('\n')}`)
}
