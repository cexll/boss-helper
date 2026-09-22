#!/usr/bin/env node
// scripts/gates-lib.mjs — shared plumbing for the harness gates.
//
// One authority: constraints.yaml holds every threshold and exemption. Gates read
// it through here. A missing key is a hard usage error (exit 2), never a silent
// default — a gate that invents its own number is unaccountable.
//
// Exit-code contract (gate-quality-contract.md):
//   0 = checked and conforming (always prints a summary; silent green is forbidden)
//   1 = named violations
//   2 = usage error / tool or config broken (fail closed)
//   3 = required input artifact missing

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..')

// ── constraints.yaml reader (line-scan, no dependency) ──────────────────────

function readConstraintsText() {
  const p = path.join(REPO_ROOT, 'constraints.yaml')
  if (!fs.existsSync(p)) {
    fail2('constraints.yaml missing at repo root — reinstall the harness (harness-init repair)')
  }
  return fs.readFileSync(p, 'utf8')
}

/** Slice out the text of one top-level block (`key:` up to the next top-level key). */
export function topBlock(text, key) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (start === -1) return ''
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z0-9_-]+:/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

/** Descend a nested key path and return the scalar after `:` on the final line. */
function scalarAt(text, keys) {
  let current = text
  for (let i = 0; i < keys.length; i += 1) {
    const lines = current.split('\n')
    let idx = -1
    let keyIndent = -1
    for (let j = 0; j < lines.length; j += 1) {
      const m = lines[j].match(/^(\s*)([A-Za-z0-9_.-]+):/)
      if (m && m[2] === keys[i]) {
        idx = j
        keyIndent = m[1].length
        break
      }
    }
    if (idx === -1) return null
    if (i === keys.length - 1) {
      return lines[idx]
        .slice(lines[idx].indexOf(':') + 1)
        .split('#')[0]
        .trim()
    }
    const body = []
    for (const line of lines.slice(idx + 1)) {
      if (line.trim() === '') {
        body.push(line)
        continue
      }
      const ind = line.match(/^\s*/)[0].length
      if (ind <= keyIndent) break
      body.push(line.slice(keyIndent + 2))
    }
    current = body.join('\n')
  }
  return null
}
/** Required numeric threshold. Missing/non-numeric is a usage error, not a default. */
export function needNumber(keyPath, label = keyPath.join('.')) {
  const raw = scalarAt(readConstraintsText(), keyPath)
  if (raw === null || raw === '') {
    fail2(`constraints.yaml: ${label} missing or empty — set it explicitly`)
  }
  const n = Number(raw.replace(/^"|"$/g, ''))
  if (!Number.isFinite(n)) {
    fail2(`constraints.yaml: ${label} is not a number (got ${JSON.stringify(raw)})`)
  }
  return n
}

/** Inline list under a key path, e.g. `paths: [a, b]`. */
export function needInlineList(keyPath, label = keyPath.join('.')) {
  const raw = scalarAt(readConstraintsText(), keyPath)
  if (raw === null) fail2(`constraints.yaml: ${label} missing`)
  const inline = raw.replace(/^\[/, '').replace(/\]$/, '').trim()
  if (inline === '') return []
  return inline
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

/** exemption entries: [{path, rules[]}] read from constraints.yaml. */
export function exemptions() {
  const block = topBlock(readConstraintsText(), 'exemptions')
  const entries = []
  let cur = null
  for (const line of block.split('\n')) {
    const start = line.match(/^\s*-\s*path:\s*(\S+)/)
    if (start) {
      if (cur) entries.push(cur)
      cur = { path: start[1].replace(/^"|"$/g, ''), rules: [] }
      continue
    }
    const rules = line.match(/^\s*rules:\s*\[(.*)\]/)
    if (rules && cur) {
      cur.rules = rules[1]
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean)
    }
  }
  if (cur) entries.push(cur)
  // fail closed: an exemption naming a path that no longer exists is stale
  for (const e of entries) {
    if (!fs.existsSync(path.join(REPO_ROOT, e.path))) {
      fail2(
        `constraints.yaml exemptions: path "${e.path}" does not exist — renamed or removed? update the list in the same change`,
      )
    }
  }
  return entries
}

/** True when `relPath` is exempted from the named rule group. */
export function isExempt(relPath, ruleGroup, entries = exemptions()) {
  const p = relPath.split(path.sep).join('/')
  return entries.some((e) => e.path === p && e.rules.includes(ruleGroup))
}

// ── source-file enumeration ─────────────────────────────────────────────────

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.wxt', '.output', '.run', 'dist', 'coverage'])

export function isSourceFile(relPath) {
  return SOURCE_EXT.has(path.extname(relPath))
}

/** All non-declaration source files, repo-relative, sorted. */
export function listSourceFiles(root = REPO_ROOT, rel = '') {
  const out = []
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
      out.push(...listSourceFiles(root, r))
    } else if (isSourceFile(r) && !r.endsWith('.d.ts')) {
      out.push(r)
    }
  }
  return out.sort()
}

// ── child process ───────────────────────────────────────────────────────────

/** Run a command; return {code, stdout, stderr}. Missing/crashed binary is exit 2. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  if (r.error || r.status === null) {
    fail2(
      `gate cannot run \`${cmd} ${args.join(' ')}\`: ${r.error?.message ?? 'killed/signal'} — a gate that cannot run has not passed`,
    )
  }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ── findings tuples ─────────────────────────────────────────────────────────

/** Normalize an oxlint `-f github` line into {kind,file,line,severity}, else null. */
export function tupleFromGithubLine(line) {
  const m = line.match(/^::(warning|error) file=([^,]+),line=(\d+).*?title=([^:]+)::/)
  if (!m) return null
  return { kind: `lint:${m[4]}`, file: m[2], line: Number(m[3]), severity: m[1] }
}

export function tupleKey(t) {
  return `${t.kind}\u0000${t.file}`
}

/** Map of tupleKey -> count. */
export function tally(tuples) {
  const m = new Map()
  for (const t of tuples) {
    const k = tupleKey(t)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

export function readBaseline(file) {
  const p = path.join(REPO_ROOT, file)
  if (!fs.existsSync(p)) {
    fail2(`${file} missing — record it with \`bun run check:baseline --record\``)
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    fail2(`${file} is not valid JSON: ${e.message}`)
  }
  if (
    !data ||
    typeof data !== 'object' ||
    typeof data.counts !== 'object' ||
    typeof data.tuples !== 'object'
  ) {
    fail2(`${file} malformed — expected {rev, counts, tuples, legacyUntested}`)
  }
  return data
}

// ── reporting ───────────────────────────────────────────────────────────────

export function fail2(msg) {
  process.stderr.write(`usage error: ${msg}\n`)
  process.exit(2)
}

/** An empty scan is a broken scan, never a pass. */
export function requireNonEmpty(name, n) {
  if (n === 0) {
    fail2(
      `${name}: checked 0 items — an empty gate would pass silently; check the file list / exclusions`,
    )
  }
}

export function exitWith(code) {
  process.exitCode = code
}
