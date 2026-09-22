#!/usr/bin/env node
// scripts/coverage-lib.mjs — lcov parser shared by coverage/crap gates and their self-tests.
//
// bun test emits lcov only (`--coverage-reporter=lcov`). The map produced here is
// the gates' normalized line-hit view: { "<repo/relative/file>": { lines: Map<number, hits> } }.
// It is NOT istanbul JSON — nothing here claims FN/FNH function-level hit data,
// because bun's lcov omits per-function counts. Files absent from the artifact
// count as unexecuted (fail closed).

export function parseLcov(text) {
  if (typeof text !== 'string') throw new Error('parseLcov: input must be a string')
  const out = {}
  let cur = null
  let seenAny = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('SF:')) {
      cur = { lines: new Map() }
      out[normalizeSf(line.slice(3))] = cur
      continue
    }
    if (!cur) {
      // TN:/end-of-record noise before any SF is tolerated; anything else before a
      // record start means the file is not an lcov we recognize.
      if (line.startsWith('end_of_record') || line.startsWith('TN:')) continue
      throw new Error(`parseLcov: unexpected line before first SF record: ${line.slice(0, 60)}`)
    }
    if (line.startsWith('DA:')) {
      const m = line.match(/^DA:(\d+),(\d+)/)
      if (!m) throw new Error(`parseLcov: malformed DA record: ${line}`)
      cur.lines.set(Number(m[1]), Number(m[2]))
      seenAny = true
      continue
    }
    if (line.startsWith('end_of_record')) {
      cur = null
      continue
    }
    // LF/LH/FNF/FNH/BRDA/etc: metadata we don't rely on.
  }
  if (!seenAny && Object.keys(out).length === 0) {
    throw new Error('parseLcov: no records found — is this an lcov file?')
  }
  return out
}

/** SF paths from bun are repo-relative; guard absolute and ./ forms anyway. */
function normalizeSf(p) {
  let s = p.split('\\').join('/')
  s = s.replace(/^\.\//, '')
  const marker = '/boss-helper/'
  if (s.startsWith('/') && s.includes(marker)) s = s.slice(s.indexOf(marker) + marker.length)
  return s
}

/**
 * Line coverage for a set of executable candidate lines.
 * Returns { coverage, unknown } where unknown=true when any body line is absent
 * from the record (counted as unexecuted, conservative).
 */
export function coverageOf(bodyLines, lineMap) {
  if (bodyLines.length === 0) return { coverage: 1, unknown: false }
  let hit = 0
  let unknown = false
  for (const l of bodyLines) {
    if (!lineMap || !lineMap.has(l)) {
      unknown = true
      continue
    }
    if (lineMap.get(l) > 0) hit += 1
  }
  return { coverage: hit / bodyLines.length, unknown }
}
