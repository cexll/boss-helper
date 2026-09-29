#!/usr/bin/env node
// scripts/test-gates.mjs — self-proof for the measurement gates (dual assertion,
// all five states where constructible): clean-pass / violation / missing-artifact /
// malformed-input / usage-error. Fixture-construction boundary: temp dirs under
// .run/gate-selftest (gitignored), never live-repo state as the expectation source.
//
//   bun run test:gates
//
// Each block: NAME — what it must do. A block that fails means the named gate is
// phantom enforcement: it cannot be trusted until green.

import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, run } from './gates-lib.mjs'

const tmp = path.join(REPO_ROOT, '.run/gate-selftest')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

let pass = 0
let fail = 0

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
    pass += 1
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    fail += 1
  }
}

function writeLcov(file, records) {
  // records: { "src/x.ts": [[line, hits], ...] }
  let out = 'TN:\n'
  for (const [sf, lines] of Object.entries(records)) {
    out += `SF:${sf}\n`
    for (const [l, h] of lines) out += `DA:${l},${h}\n`
    out += 'end_of_record\n'
  }
  fs.writeFileSync(file, out)
}

// ── coverage-gate ───────────────────────────────────────────────────────────
// Synthetic lcov that covers EVERY src .ts file at 100% (one hit line per file)
// must pass; one that covers nothing must fail naming files; junk must exit 3.
function allTsFiles() {
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
      } else if (r.endsWith('.ts') && !r.endsWith('.d.ts')) out.push(r)
    }
  }
  walk('src')
  return out
}
const tsFiles = allTsFiles()
const full = {}
for (const f of tsFiles) full[f] = [[1, 5]]
writeLcov(path.join(tmp, 'full.lcov'), full)
const none = {}
for (const f of tsFiles) none[f] = [[1, 0]]
writeLcov(path.join(tmp, 'none.lcov'), none)

let r = run('node', [
  'scripts/coverage-gate.mjs',
  '--lcov',
  '.run/gate-selftest/full.lcov',
  '--scope',
  'all',
])
check(
  'coverage-gate: clean fixture exits 0',
  r.code === 0,
  `exit=${r.code} ${r.stderr.slice(0, 200)}`,
)
r = run('node', [
  'scripts/coverage-gate.mjs',
  '--lcov',
  '.run/gate-selftest/none.lcov',
  '--scope',
  'all',
])
check(
  'coverage-gate: uncovered fixture exits 1 naming files',
  r.code === 1 && /FAIL  src\//.test(r.stderr),
  `exit=${r.code}`,
)
r = run('node', [
  'scripts/coverage-gate.mjs',
  '--lcov',
  '.run/gate-selftest/missing.lcov',
  '--scope',
  'all',
])
check('coverage-gate: missing artifact exits 3', r.code === 3, `exit=${r.code}`)
fs.writeFileSync(path.join(tmp, 'junk.lcov'), 'this is not lcov at all\n')
r = run('node', [
  'scripts/coverage-gate.mjs',
  '--lcov',
  '.run/gate-selftest/junk.lcov',
  '--scope',
  'all',
])
check('coverage-gate: malformed artifact exits 3', r.code === 3, `exit=${r.code}`)
r = run('node', ['scripts/coverage-gate.mjs'])
check('coverage-gate: no --lcov exits 2 (usage)', r.code === 2, `exit=${r.code}`)
// missing-file state: a file removed from the fixture is counted 0% → fails by name
{
  const drop = 'src/utils/logger.ts'
  const partial = Object.fromEntries(Object.entries(full).filter(([k]) => k !== drop))
  writeLcov(path.join(tmp, 'partial.lcov'), partial)
  r = run('node', [
    'scripts/coverage-gate.mjs',
    '--lcov',
    '.run/gate-selftest/partial.lcov',
    '--scope',
    'all',
  ])
  check(
    'coverage-gate: file absent from artifact fails closed by name',
    r.code === 1 && r.stderr.includes(drop),
    `exit=${r.code}`,
  )
}

// ── change-risk-gate (CRAP) ─────────────────────────────────────────────────
const linemap = path.join(tmp, 'linemap.json')
fs.writeFileSync(
  linemap,
  JSON.stringify(
    Object.fromEntries(
      tsFiles.map((f) => [
        f,
        {
          lines: Object.fromEntries(
            fs
              .readFileSync(path.join(REPO_ROOT, f), 'utf8')
              .split('\n')
              .map((_, i) => [String(i + 1), 5]),
          ),
        },
      ]),
    ),
  ),
)
r = run('node', [
  'scripts/change-risk-gate.mjs',
  '--coverage',
  linemap,
  '--ceiling',
  '15.76',
  '--src',
  'src/composables/useApplying/abortPolicy.ts',
])
check(
  'change-risk-gate: covered low-complexity file exits 0',
  r.code === 0,
  `exit=${r.code} ${r.stderr.slice(0, 200)}`,
)
r = run('node', [
  'scripts/change-risk-gate.mjs',
  '--coverage',
  '.run/gate-selftest/nope.json',
  '--ceiling',
  '15.76',
  '--src',
  'src',
])
check('change-risk-gate: missing coverage exits 3', r.code === 3, `exit=${r.code}`)
r = run('node', [
  'scripts/change-risk-gate.mjs',
  '--coverage',
  linemap,
  '--ceiling',
  '15.76',
  '--src',
  '.run/gate-selftest',
])
check('change-risk-gate: empty scan exits 2 (never silently green)', r.code === 2, `exit=${r.code}`)
// violation + threshold-failure states on synthetic fixtures (never live-repo state):
// .run/ is formatter-excluded, so these temp files can't skew the format lane.
fs.writeFileSync(path.join(tmp, 'simple.ts'), 'export function f() {\n  return 1\n}\n')
fs.writeFileSync(
  path.join(tmp, 'complex.ts'),
  'export function g(x) {\n  if (x) if (x) if (x) if (x) if (x) if (x) {\n    return 1\n  }\n  return 0\n}\n',
)
const coveredMap = path.join(tmp, 'covered.json')
fs.writeFileSync(
  coveredMap,
  JSON.stringify({ [`${tmp}/simple.ts`]: { lines: { 1: 5, 2: 5, 3: 1 } } }),
)
const gateRun = (cov, ceiling, src) =>
  run('node', [
    'scripts/change-risk-gate.mjs',
    '--coverage',
    cov,
    '--ceiling',
    ceiling,
    '--src',
    src,
  ])
// boundary: score 1.0 passes ceiling 1.0 (== ceiling allowed), fails ceiling 0.99
r = gateRun(coveredMap, '1.0', path.join(tmp, 'simple.ts'))
check(
  'change-risk-gate: score==ceiling passes',
  r.code === 0,
  `exit=${r.code} ${r.stderr.slice(0, 200)}`,
)
r = gateRun(coveredMap, '0.99', path.join(tmp, 'simple.ts'))
check(
  'change-risk-gate: score>ceiling fails by 0.01',
  r.code === 1 && /FAIL/.test(r.stdout),
  `exit=${r.code} ${r.stdout.slice(0, 120)}`,
)
// uncovered complex function (absent from map → 0% conservative): c=7 → score 56 > 15.76, names g
const emptyMap = path.join(tmp, 'empty-linemap.json')
fs.writeFileSync(emptyMap, '{}')
r = gateRun(emptyMap, '15.76', path.join(tmp, 'complex.ts'))
check(
  'change-risk-gate: uncovered complex function fails naming g [cov-unknown]',
  r.code === 1 && /\bg\b/.test(r.stdout) && r.stdout.includes('cov-unknown'),
  `exit=${r.code} ${r.stdout.slice(0, 200)}`,
)

// ── check-baseline compare (mutate-then-restore; the committed baseline is the fixture source) ──
{
  const bp = path.join(REPO_ROOT, '.baseline/findings.json')
  if (!fs.existsSync(bp)) {
    check(
      'check-baseline: recorded baseline present',
      false,
      '.baseline/findings.json missing — run `bun run baseline:record` first (Stage 5 order)',
    )
  } else {
    const original = fs.readFileSync(bp, 'utf8')
    try {
      r = run('node', ['scripts/check-baseline.mjs'])
      check(
        'check-baseline: compare against fresh record exits 0',
        r.code === 0,
        `exit=${r.code} ${r.stderr.slice(0, 300)}`,
      )
      // tighten one ceiling to 0 → the lane must fail naming the increase
      const tampered = JSON.parse(original)
      const firstKey = Object.keys(tampered.tuples)[0]
      tampered.tuples[firstKey] = 0
      fs.writeFileSync(bp, JSON.stringify(tampered, null, 2))
      r = run('node', ['scripts/check-baseline.mjs'])
      const [kind, file] = firstKey.split('\u0000')
      check(
        'check-baseline: NEW/INCREASED tuple rejected and named',
        r.code === 1 && r.stderr.includes('NEW/INCREASED') && r.stderr.includes(file.slice(0, 24)),
        `exit=${r.code}`,
      )
      void kind
      // loosen everything (huge ceilings) → slack check must fail (decreases require re-record)
      const loose = JSON.parse(original)
      for (const k of Object.keys(loose.counts)) loose.counts[k] = 10_000
      fs.writeFileSync(bp, JSON.stringify(loose, null, 2))
      r = run('node', ['scripts/check-baseline.mjs'])
      check(
        'check-baseline: loose ceilings flagged (count decrease needs re-record)',
        r.code === 1 && r.stderr.includes('LOWER'),
        `exit=${r.code}`,
      )
    } finally {
      fs.writeFileSync(bp, original)
    }
  }
}

// ── check-lockfile-consistency ─────────────────────────────────────────────
r = run('node', ['scripts/check-lockfile-consistency.mjs'])
check('check-lockfile: usage error without base exits 2', r.code === 2, `exit=${r.code}`)
r = run('node', ['scripts/check-lockfile-consistency.mjs', 'HEAD'])
check(
  'check-lockfile: HEAD..HEAD reports no drift (exit 0)',
  r.code === 0,
  `exit=${r.code} ${r.stderr.slice(0, 120)}`,
)

// ── check-crap (per-target coverage binding + no-function scope) ────────────
// Regression harness: with `--src <file>` the gate's coverage lookup used to
// bind ANY same-basename entry (packages/…/index.ts could mask src/…/index.ts →
// false FAIL), and a zero-function file aborted the whole run as "untrusted".
{
  const crapDir = path.join(tmp, 'crap')
  fs.mkdirSync(path.join(crapDir, 'a'), { recursive: true })
  fs.mkdirSync(path.join(crapDir, 'packages-other'), { recursive: true })
  const gSrc =
    'export function g(x) {\n  if (x) if (x) if (x) if (x) if (x) if (x) {\n    return 1\n  }\n  return 0\n}\n'
  fs.writeFileSync(path.join(crapDir, 'a', 'index.ts'), gSrc)
  fs.writeFileSync(path.join(crapDir, 'packages-other', 'index.ts'), gSrc)
  fs.writeFileSync(path.join(crapDir, 'noop.ts'), 'export type Only = 1\n')
  const coveredHits = Object.fromEntries(
    fs
      .readFileSync(path.join(crapDir, 'a', 'index.ts'), 'utf8')
      .split('\n')
      .map((_, i) => [String(i + 1), 5]),
  )
  const crapMap = path.join(tmp, 'crap-linemap.json')
  // insertion order is the trap: the UNCOVERED packages-like entry comes first
  fs.writeFileSync(
    crapMap,
    JSON.stringify({
      'packages/other/index.ts': { lines: {} },
      [path.join(crapDir, 'a', 'index.ts')]: { lines: coveredHits },
    }),
  )
  const crapRun = (...flags) => run('node', ['scripts/check-crap.mjs', ...flags])
  r = crapRun('--linemap', crapMap, '--target', path.join(crapDir, 'a', 'index.ts'))
  check(
    'check-crap: covered target binds its OWN linemap entry (no basename-collision false FAIL)',
    r.code === 0 && /PASS/.test(r.stdout),
    `exit=${r.code} ${r.stderr.slice(0, 200)}`,
  )
  r = crapRun('--linemap', crapMap, '--target', path.join(crapDir, 'noop.ts'))
  check(
    'check-crap: zero-function target is a scoped note, not an untrusted abort',
    r.code === 0 && /no functions/i.test(r.stdout),
    `exit=${r.code} ${r.stderr.slice(0, 200)}`,
  )
  r = crapRun('--linemap', crapMap, '--target', path.join(crapDir, 'packages-other', 'index.ts'))
  check(
    'check-crap: uncovered target still fails (the fix must not weaken the gate)',
    r.code === 1,
    `exit=${r.code}`,
  )
}

// ── gates-lib parsing honesty ──────────────────────────────────────────────
{
  const { default: mod } = await import('./gates-lib.mjs').then((m) => ({ default: m }))
  void mod
  const g = (await import('./gates-lib.mjs')).tupleFromGithubLine
  const t = g(
    '::warning file=src/a.ts,line=3,endLine=3,col=1,endColumn=2,title=eslint(no-console)::Unexpected console statement.',
  )
  check(
    'gates-lib: github-format tuple parses kind/file/line',
    !!t && t.kind === 'lint:eslint(no-console)' && t.file === 'src/a.ts' && t.line === 3,
    JSON.stringify(t),
  )
  check('gates-lib: non-finding lines parse to null', g('Finished in 1s on 2 files') === null)
}

console.log(`\ntest-gates: ${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
