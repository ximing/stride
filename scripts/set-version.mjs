#!/usr/bin/env node
// Single source of truth for the release version.
//
// The release workflow calls this with the pushed tag (e.g. `v0.1.1`) before
// electron-builder. It writes only apps/desktop/package.json. electron-builder
// and electron-updater read that version. Local use:
// `node scripts/set-version.mjs 0.1.1` (or v0.1.1).

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const FILES = ['apps/desktop/package.json']

function usageAndExit(code) {
  console.error('usage: node scripts/set-version.mjs <version>   (e.g. 0.1.1 or v0.1.1)')
  process.exit(code)
}

const arg = process.argv[2]
if (!arg || arg.startsWith('-')) usageAndExit(1)
const version = arg.replace(/^v/, '')
// Strict x.y.z (optionally with prerelease/build suffix); the updater's
// compareVersions and latest.json consumers both assume this shape.
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a valid release version: ${arg}`)
  usageAndExit(1)
}

for (const relPath of FILES) {
  const absPath = join(repoRoot, relPath)
  const text = readFileSync(absPath, 'utf8')
  const json = JSON.parse(text)
  if (json.version === version) {
    console.log(`${relPath}: already ${version}`)
    continue
  }
  // JSON.stringify would reformat the whole file; do a surgical edit on the
  // `"version": "..."` line instead so diffs stay one line per file.
  const line = new RegExp(`^(\\s*)"version"\\s*:\\s*"[^"]*"(.*)$`, 'm')
  if (!line.test(text)) {
    console.error(`${relPath}: no "version" field found — refusing to guess`)
    process.exit(1)
  }
  writeFileSync(absPath, text.replace(line, `$1"version": "${version}"$2`))
  console.log(`${relPath}: ${json.version} -> ${version}`)
}
