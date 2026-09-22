#!/usr/bin/env node
// scripts/lcov-to-linemap.mjs — adapter: bun lcov → the gates' normalized line-hit map.
//
//   usage: lcov-to-linemap.mjs <lcov.info> <out.json>
//
// Output shape: { "<repo-relative/file>": { "lines": { "<line>": <hits> } } }.
// This is a normalized line map for scripts/change-risk-gate.mjs — deliberately NOT
// called "istanbul": it carries line hits only (bun's lcov has no per-function hit
// counts; FN/FNH there are record-level summaries, not statement maps).
// Files absent from the lcov simply do not appear; consumers treat absence as
// unexecuted (conservative / red).

import fs from 'node:fs'

import { parseLcov } from './coverage-lib.mjs'

const [lcovPath, outPath] = process.argv.slice(2)
if (!lcovPath || !outPath) {
  process.stderr.write('usage: lcov-to-linemap.mjs <lcov.info> <out.json>\n')
  process.exit(2)
}
if (!fs.existsSync(lcovPath)) {
  process.stderr.write(
    `lcov-to-linemap: input not found: ${lcovPath} (run \`bun run test:coverage\` first)\n`,
  )
  process.exit(3)
}
let records
try {
  records = parseLcov(fs.readFileSync(lcovPath, 'utf8'))
} catch (e) {
  process.stderr.write(`lcov-to-linemap: cannot parse ${lcovPath}: ${e.message}\n`)
  process.exit(3)
}
const out = {}
for (const [file, rec] of Object.entries(records)) {
  out[file] = { lines: Object.fromEntries(rec.lines) }
}
fs.mkdirSync(outPath.slice(0, outPath.lastIndexOf('/')) || '.', { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify(out)}\n`)
process.stdout.write(`lcov-to-linemap: ${Object.keys(out).length} file record(s) -> ${outPath}\n`)
