#!/usr/bin/env node
// scripts/build-smoke.mjs — built-artifact gate: the zipped extension output is
// checked through its manifest, not its source. Run after `bun run build:chrome`
// (and optionally the other browsers via --all).
//
// Exit: 0 conforming / 1 named failures / 2 usage / 3 build output missing.

import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, fail2, exitWith } from './gates-lib.mjs'

const wantAll = process.argv.includes('--all')
const browsers = wantAll ? ['chrome-mv3', 'firefox-mv2', 'edge-mv3'] : ['chrome-mv3']
const outRoot = path.join(REPO_ROOT, '.output')
const failures = []

function check(cond, msg) {
  if (!cond) failures.push(msg)
}

for (const b of browsers) {
  const dir = path.join(outRoot, b)
  if (!fs.existsSync(dir)) {
    process.stderr.write(
      `build-smoke: output missing: .output/${b} — run \`bun run build\` first\n`,
    )
    exitWith(3)
  }
  const manifestPath = path.join(dir, 'manifest.json')
  let m
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    fail2(`build-smoke: cannot read .output/${b}/manifest.json: ${e.message}`)
  }
  const mv = b.includes('mv2') ? 2 : 3
  check(m.manifest_version === mv, `${b}: manifest_version ${m.manifest_version} != expected ${mv}`)
  check(typeof m.name === 'string' && m.name.length > 0, `${b}: manifest name missing`)
  check(
    m.default_locale === 'zh_CN',
    `${b}: default_locale drifted (store listing depends on _locales)`,
  )
  check(
    /__MSG_extName__|Boss/i.test(String(m.name)) || b !== 'chrome-mv3',
    `${b}: extension name drifted from packaged identity`,
  )
  check(
    Array.isArray(m.permissions) && m.permissions.includes('storage'),
    `${b}: storage permission missing — extension cannot persist config`,
  )
  for (const need of ['storage', 'cookies', 'notifications']) {
    check(
      m.permissions?.includes(need),
      `${b}: permission "${need}" missing (declared in wxt.config.ts)`,
    )
  }
  check(
    Array.isArray(m.host_permissions) && m.host_permissions.length > 0,
    `${b}: host_permissions empty`,
  )
  // entry files emitted by WXT must exist
  const expects =
    b === 'chrome-mv3'
      ? ['content-scripts/content.js', 'background.js']
      : ['content-scripts/content.js']
  for (const f of expects) {
    const present =
      fs.existsSync(path.join(dir, f)) ||
      (f === 'background.js' &&
        (fs.existsSync(path.join(dir, 'background.js')) ||
          fs.existsSync(path.join(dir, 'common', 'background.js'))))
    check(present, `${b}: expected built entry missing: ${f}`)
  }
  // locales shipped
  check(
    fs.existsSync(path.join(dir, '_locales', 'zh_CN', 'messages.json')),
    `${b}: _locales/zh_CN/messages.json missing`,
  )
}

if (failures.length) {
  process.stderr.write(`build-smoke: ${failures.length} failure(s):\n`)
  for (const f of failures) process.stderr.write(`  ${f}\n`)
  exitWith(1)
} else {
  process.stdout.write(
    `build-smoke: PASS — ${browsers.join(', ')} manifests and entry files conform (${fs.readdirSync(outRoot).length} outputs in .output)\n`,
  )
  exitWith(0)
}
