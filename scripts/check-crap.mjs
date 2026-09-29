#!/usr/bin/env node
// scripts/check-crap.mjs — diff-scoped change-risk (CRAP) gate.
//
//   usage: check-crap.mjs [--base <ref>] [--all]
//          check-crap.mjs --linemap <file> --target <file> [--target <file>]…
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
//
// Self-test mode (--linemap + --target, repeatable) skips the diff scope and the
// fresh bun-test run so the binding behaviour is provable on synthetic fixtures.
//
// Coverage binding: the upstream gate resolves a linemap key per analysed file by
// absolute path, repo-relative path, or — last resort — bare basename. That last
// resort is a collision hazard (packages/…/index.ts can mask src/…/index.ts and
// hand the gate another file's line map, turning a covered function into a false
// FAIL). This wrapper therefore binds each target to a single-entry map holding
// only that target's own entry, so no other file can answer for it; a target
// absent from the map stays absent (0% by definition, fail-closed).

import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, fail2, run, needNumber } from './gates-lib.mjs'

const argv = process.argv.slice(2)
const args = { base: null, all: false, linemap: null, targets: [] }
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--base') args.base = argv[++i]
  else if (argv[i] === '--all') args.all = true
  else if (argv[i] === '--linemap') args.linemap = argv[++i]
  else if (argv[i] === '--target') args.targets.push(argv[++i])
  else fail2(`check-crap: unknown argument ${argv[i]}`)
}
const selftest = Boolean(args.linemap)
if (selftest !== Boolean(args.targets.length))
  fail2('check-crap: --linemap and --target must be used together')
if (selftest && (args.base || args.all))
  fail2('check-crap: --linemap/--target cannot be combined with --base/--all')
if (!selftest && !args.base && process.env.CRAP_BASE) args.base = process.env.CRAP_BASE

const ceiling = needNumber(
  ['size_limits', 'max_crap_score', 'value'],
  'size_limits.max_crap_score.value',
)

let linemap
if (selftest) {
  linemap = path.resolve(args.linemap)
  if (!fs.existsSync(linemap)) fail2(`check-crap: --linemap not found at ${linemap}`)
} else {
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
  linemap = path.join(REPO_ROOT, covDir, 'linemap.json')
  const conv = run('node', ['scripts/lcov-to-linemap.mjs', covDir + '/lcov.info', linemap])
  if (conv.code !== 0) {
    process.stderr.write(conv.stdout + conv.stderr)
    fail2('check-crap: lcov->linemap adapter failed')
  }
}

// 3. scope
const sourceFilesUnder = (dir) => {
  const out = []
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${ent.name}`
      if (ent.isDirectory()) walk(r)
      else if (r.endsWith('.ts') && !r.endsWith('.d.ts')) out.push(r)
    }
  }
  walk(dir)
  return out.sort((a, b) => a.localeCompare(b))
}
let targets
if (selftest) {
  targets = args.targets.map((t) => path.resolve(t))
  for (const t of targets) if (!fs.existsSync(t)) fail2(`check-crap: --target not found at ${t}`)
} else if (args.all) {
  targets = sourceFilesUnder('src')
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

// 4. run the gate per target, one target at a time with its own coverage entry.
const linemapData = JSON.parse(fs.readFileSync(linemap, 'utf8'))
const ownEntry = (target) => {
  const abs = path.resolve(REPO_ROOT, target)
  const rel = path.relative(REPO_ROOT, abs)
  const candidates = [abs, rel, `./${rel}`, target, path.resolve(target)]
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(linemapData, key))
      return { key, entry: linemapData[key] }
  }
  // Suffix match only when unambiguous: two same-basename files must never answer
  // for each other (that ambiguity is the defect this wrapper exists to prevent).
  const suffix = candidates.map((k) => k.replace(/^\.\//, ''))
  const hits = Object.keys(linemapData).filter((k) =>
    suffix.some((s) => k === s || k.endsWith(`/${s}`)),
  )
  if (hits.length === 1) return { key: hits[0], entry: linemapData[hits[0]] }
  return null
}

const boundDir = path.join(REPO_ROOT, '.run/coverage-crap/bound')
fs.mkdirSync(boundDir, { recursive: true })
let worst = 0
const noFn = []
for (const target of targets) {
  const own = ownEntry(target)
  const boundPath = path.join(boundDir, `${Buffer.from(target).toString('base64url')}.json`)
  fs.writeFileSync(boundPath, JSON.stringify(own ? { [own.key]: own.entry } : {}))
  const r = run('node', [
    'scripts/change-risk-gate.mjs',
    '--coverage',
    boundPath,
    '--ceiling',
    String(ceiling),
    '--src',
    target,
  ])
  const text = `${r.stdout}${r.stderr}`
  if (r.code === 2 || r.code === 3) {
    if (r.code === 2 && /no functions found under/.test(`${r.stdout}${r.stderr}`)) {
      // Type-only module: it carries no functions, so there is nothing to gate.
      // Recorded as a scoped note rather than an untrusted abort — the previous
      // behaviour killed the whole run at conf/info.ts and left every later
      // target unevaluated.
      noFn.push(target)
      process.stdout.write(`check-crap: ${target} — no functions (type-only), nothing to gate\n`)
      continue
    }
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
    process.stdout.write(
      `check-crap: ${target} — PASS (ceiling ${ceiling}${own ? '' : ', no coverage entry → 0%'})\n`,
    )
  }
}
if (noFn.length)
  process.stdout.write(
    `check-crap: scope note — ${noFn.length} file(s) carry no functions: ${noFn.join(', ')}\n`,
  )
if (worst === 1) {
  process.stderr.write(
    `check-crap: FAIL — add tests covering the branches or simplify the function. Never raise size_limits.max_crap_score.value to pass.\n`,
  )
}
process.exitCode = worst
