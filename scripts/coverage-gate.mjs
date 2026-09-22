#!/usr/bin/env node
// scripts/coverage-gate.mjs — 85% line-coverage block gate (per-file, fail closed).
//
//   usage: coverage-gate.mjs --lcov <file> [--scope changed|all] [--base <ref>] [--json]
//
// Semantics:
//   * Every .ts source file under src/ (excluding .d.ts and .test.ts) must appear
//     in the lcov artifact. A file absent from coverage counts as 0% (fail closed)
//     UNLESS it is listed in constraints.yaml `baseline.legacy_untested_files`
//     (frozen legacy set — may only shrink; check-baseline.mjs enforces that).
//   * Per-file line percentage must be >= testing.min_line_coverage.value.
//   * `--scope changed` (CI default): blocks added-or-changed files vs --base plus
//     every file not in the legacy set; `--scope all` (self-test) blocks everything.
// Exit: 0 conforming / 1 named failures / 2 usage / 3 lcov missing or malformed.

import fs from 'node:fs'
import path from 'node:path'

import { parseLcov } from './coverage-lib.mjs'
import { REPO_ROOT, fail2, needNumber, run, topBlock, exitWith } from './gates-lib.mjs'

const argv = process.argv.slice(2)
const args = { lcov: null, scope: 'changed', base: null, json: false }
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--lcov') args.lcov = argv[++i]
  else if (a === '--scope') args.scope = argv[++i]
  else if (a === '--base') args.base = argv[++i]
  else if (a === '--json') args.json = true
  else fail2(`coverage-gate: unknown argument ${a}`)
}
if (!args.lcov) fail2('coverage-gate: --lcov <file> required (run `bun run test:coverage` first)')
if (!['changed', 'all'].includes(args.scope))
  fail2(`coverage-gate: --scope must be changed|all (got ${args.scope})`)
if (!fs.existsSync(args.lcov)) {
  process.stderr.write(
    `coverage-gate: coverage artifact not found: ${args.lcov}\n  Produce it with \`bun run test:coverage\` (CI does this automatically).\n`,
  )
  process.exit(3)
}

let records
try {
  records = parseLcov(fs.readFileSync(args.lcov, 'utf8'))
} catch (e) {
  process.stderr.write(`coverage-gate: cannot parse lcov: ${e.message}\n`)
  process.exit(3)
}
const threshold = needNumber(
  ['testing', 'min_line_coverage', 'value'],
  'testing.min_line_coverage.value',
)

// Legacy set: the frozen registry of zero-coverage .ts files, from the baseline block.
const constraints = fs.readFileSync(path.join(REPO_ROOT, 'constraints.yaml'), 'utf8')
const baselineBlock = topBlock(constraints, 'baseline')
export function parseLegacySet(blockText) {
  const blines = blockText.split('\n')
  // exact two-space indent: the list row, not the counts.legacy_untested_count scalar
  const li = blines.findIndex((l) => /^ {2}legacy_untested_files:/.test(l))
  if (li === -1)
    fail2('coverage-gate: baseline.legacy_untested_files key missing from constraints.yaml')
  const inline = blines[li]
    .slice(blines[li].indexOf(':') + 1)
    .split('#')[0]
    .trim()
  const set = new Set()
  if (inline && inline !== '[]') {
    for (const s of inline.replace(/^\[/, '').replace(/\]$/, '').split(',')) {
      const v = s.trim().replace(/^"|"$/g, '')
      if (v) set.add(v)
    }
  } else {
    for (const l of blines.slice(li + 1)) {
      const m = l.match(/^ {4}-\s*(.+?)\s*$/)
      if (m) set.add(m[1].replace(/^"|"$/g, ''))
      else if (l.trim() !== '') break
    }
  }
  return set
}
const legacy = parseLegacySet(baselineBlock)

export function isGatedFile(rel) {
  return rel.endsWith('.ts') && !rel.endsWith('.d.ts') && !rel.endsWith('.test.ts')
}

function sourceTsFiles() {
  const out = []
  const walk = (rel) => {
    const dir = path.join(REPO_ROOT, rel)
    if (!fs.existsSync(dir)) return out
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (
          ['node_modules', '.git', '.wxt', '.output', '.run', 'coverage'].includes(ent.name) ||
          ent.name.startsWith('.')
        )
          continue
        walk(r)
      } else if (isGatedFile(r)) {
        out.push(r)
      }
    }
  }
  walk('src')
  return out.sort()
}

function changedFiles() {
  const base = args.base ?? 'HEAD~1'
  const v = run('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  if (v.code === 0) {
    const d = run('git', [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      `${base}...HEAD`,
      '--',
      '*.ts',
    ])
    const files = new Set(d.stdout.split('\n').filter(Boolean))
    const w = run('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', '*.ts'])
    for (const f of w.stdout.split('\n').filter(Boolean)) files.add(f)
    const u = run('git', ['ls-files', '--others', '--exclude-standard'])
    for (const f of u.stdout.split('\n').filter((x) => x.endsWith('.ts'))) files.add(f)
    return files
  }
  // base does not resolve locally: use worktree diff vs HEAD, fall back to "everything not legacy"
  const w = run('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', '*.ts'])
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard'])
  return new Set([...w.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))
}

function pct(rec) {
  let hit = 0
  let total = 0
  for (const n of rec.lines.values()) {
    total += 1
    if (n > 0) hit += 1
  }
  return total === 0 ? 100 : (hit / total) * 100
}

const changed = args.scope === 'all' ? null : changedFiles()
const files = sourceTsFiles()
if (files.length === 0)
  fail2('coverage-gate: found 0 .ts source files — an empty gate would pass silently')

const rows = []
for (const f of files) {
  const inScope = args.scope === 'all' ? true : changed.has(f) || !legacy.has(f)
  if (!inScope) {
    rows.push({ file: f, status: 'legacy-exempt', coverage: records[f] ? pct(records[f]) : 0 })
    continue
  }
  const rec = records[f]
  const p = rec ? pct(rec) : 0
  rows.push({
    file: f,
    status: p >= threshold ? 'pass' : 'FAIL',
    coverage: Number(p.toFixed(2)),
    absent: !rec,
  })
}

const failed = rows.filter((r) => r.status === 'FAIL')
const gated = rows.filter((r) => r.status !== 'legacy-exempt')

if (args.json) {
  process.stdout.write(`${JSON.stringify({ threshold, scope: args.scope, rows }, null, 2)}\n`)
} else {
  process.stdout.write(
    `coverage-gate: threshold=${threshold}% scope=${args.scope} gated=${gated.length} legacy-exempt=${rows.length - gated.length}\n`,
  )
  for (const r of failed) {
    process.stderr.write(
      `  FAIL  ${r.file}  ${r.coverage}%${r.absent ? '  [absent from coverage artifact → counted 0%]' : ''}\n`,
    )
  }
  if (failed.length === 0) {
    process.stdout.write(
      `coverage-gate: PASS — all ${gated.length} in-scope file(s) at or above ${threshold}%\n`,
    )
  } else {
    process.stderr.write(`coverage-gate: FAIL — ${failed.length} file(s) below ${threshold}%\n`)
  }
}
exitWith(failed.length ? 1 : 0)
