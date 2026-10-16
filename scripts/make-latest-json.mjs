#!/usr/bin/env node
// Build the static `latest.json` consumed by tauri-plugin-updater (T8.4).
//
// Shared by the release workflow and local dry-runs so there is exactly one
// implementation of the manifest format. Input is a directory holding the
// renamed per-arch updater artifacts:
//
//   Stride_aarch64.app.tar.gz      + Stride_aarch64.app.tar.gz.sig
//   Stride_x64.app.tar.gz          + Stride_x64.app.tar.gz.sig
//
// (Any filename works as long as it contains `aarch64`/`arm64` or
// `x64`/`x86_64` and sits next to a `<name>.sig` — tauri's raw output is
// arch-less, so the pipeline renames it before calling this script.)
//
// Usage:
//   node scripts/make-latest-json.mjs --artifacts dist --tag v0.1.1 \
//        [--repo ximing/stride] [--notes "..."] [--out dist/latest.json]
//
// The generated `url`s point at the release assets of `--tag`, matching the
// asset names uploaded by .github/workflows/release.yml.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const artifactsDir = argValue('--artifacts')
const tag = argValue('--tag')
const repo = argValue('--repo') ?? 'ximing/stride'
const notes = argValue('--notes') ?? ''
const out = argValue('--out')

if (!artifactsDir || !tag) {
  console.error(
    'usage: node scripts/make-latest-json.mjs --artifacts <dir> --tag <vX.Y.Z> [--repo owner/name] [--notes "..."] [--out <file>]',
  )
  process.exit(1)
}
if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`not a release tag: ${tag}`)
  process.exit(1)
}
const version = tag.replace(/^v/, '')

// Arch token -> updater platform key. Windows/Linux join in T9.7.
// Filenames come from our own pipeline (renamed with explicit arch tokens),
// so plain substring matching is enough; no word boundaries — `_` counts as a
// word char and would defeat `\bx64\b` against `Stride_x64.app.tar.gz`.
const ARCH_MATCHERS = [
  [/aarch64|arm64/, 'darwin-aarch64'],
  [/x86_64|x64/i, 'darwin-x86_64'],
]

const platforms = {}
for (const entry of readdirSync(artifactsDir).sort()) {
  if (!entry.endsWith('.app.tar.gz')) continue
  const match = ARCH_MATCHERS.find(([re]) => re.test(entry))
  if (!match) continue
  const platform = match[1]
  if (platforms[platform]) {
    console.error(`multiple artifacts for ${platform}: ${platforms[platform].name}, ${entry}`)
    process.exit(1)
  }
  const sigPath = join(artifactsDir, `${entry}.sig`)
  let signature
  try {
    signature = readFileSync(sigPath, 'utf8').trim()
  } catch {
    console.error(`missing signature file next to ${entry}: ${sigPath}`)
    process.exit(1)
  }
  if (!signature) {
    console.error(`empty signature file: ${sigPath}`)
    process.exit(1)
  }
  platforms[platform] = {
    name: entry,
    signature,
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(entry)}`,
  }
}

for (const platform of ['darwin-aarch64', 'darwin-x86_64']) {
  if (!platforms[platform]) {
    console.error(`no .app.tar.gz for ${platform} in ${artifactsDir} (looked for *aarch64*/*x64* names)`)
    process.exit(1)
  }
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(
    Object.entries(platforms).map(([platform, { signature, url }]) => [
      platform,
      { signature, url },
    ]),
  ),
}

const json = `${JSON.stringify(manifest, null, 2)}\n`
if (out) {
  const target = resolve(out)
  writeFileSync(target, json)
  console.log(`wrote ${target} (version ${version})`)
} else {
  process.stdout.write(json)
}
// Log the resolved mapping for CI logs / local sanity checks.
for (const [platform, { name, url }] of Object.entries(platforms)) {
  console.log(`${platform}: ${name} -> ${url}`)
}
