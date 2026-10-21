#!/usr/bin/env node
// Build the static `latest.json` consumed by tauri-plugin-updater (T8.4,
// extended to all four desktop platforms 2026-10-21).
//
// Shared by the release workflow and local dry-runs so there is exactly one
// implementation of the manifest format. Input is a directory holding the
// renamed per-platform updater artifacts:
//
//   Stride_aarch64.app.tar.gz        + .sig   (darwin-aarch64)
//   Stride_x64.app.tar.gz            + .sig   (darwin-x86_64)
//   Stride_x86_64.AppImage           + .sig   (linux-x86_64)
//   Stride_x86_64-setup.exe          + .sig   (windows-x86_64)
//
// (Any filename works as long as it hits one of the MATCHERS rules below and
// sits next to a `<name>.sig` — tauri's raw output is arch-less and
// version-stamped, so the pipeline renames it before calling this script.)
//
// Windows artifact shape: tauri v2 ships the raw NSIS installer as the
// updater artifact (no zip wrapper — verified empirically on CI, tauri-cli
// 2.12: `bundle/nsis/Stride_<ver>_x64-setup.exe` + `.sig`). Linux likewise
// ships the raw AppImage (verified on CI: `bundle/appimage/*.AppImage.sig`).
//
// All four platforms are REQUIRED: a release ships everywhere or not at all.
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

// Platform keys follow the tauri-plugin-updater target triple convention
// (`{os}-{arch}`), see the `platforms` map in the updater manifest docs.
//
// Filenames come from our own pipeline (renamed with explicit platform tokens),
// so plain substring matching is enough; no word boundaries — `_` counts as a
// word char and would defeat `\bx64\b` against `Stride_x64.app.tar.gz`.
// Rules are ordered and extension-scoped so the `x64`-ish mac token can never
// swallow the linux/windows files and vice versa.
const MATCHERS = [
  {
    platform: 'darwin-aarch64',
    match: (name) => name.endsWith('.app.tar.gz') && /aarch64|arm64/.test(name),
  },
  {
    platform: 'darwin-x86_64',
    match: (name) => name.endsWith('.app.tar.gz') && /x86_64|x64/i.test(name),
  },
  {
    platform: 'linux-x86_64',
    match: (name) => name.endsWith('.AppImage'),
  },
  {
    platform: 'windows-x86_64',
    match: (name) => name.endsWith('-setup.exe') || name.endsWith('.msi'),
  },
]

const REQUIRED_PLATFORMS = ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']

const platforms = {}
for (const entry of readdirSync(artifactsDir).sort()) {
  if (entry.endsWith('.sig')) continue
  const rule = MATCHERS.find(({ match }) => match(entry))
  if (!rule) {
    if (/\.(tar\.gz|zip|exe|msi|AppImage|app)$/.test(entry)) {
      console.error(`unrecognized updater artifact (no platform match): ${entry}`)
      process.exit(1)
    }
    continue
  }
  const { platform } = rule
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

const ARTIFACT_SHAPES = {
  'darwin-aarch64': 'Stride_aarch64.app.tar.gz',
  'darwin-x86_64': 'Stride_x64.app.tar.gz',
  'linux-x86_64': 'Stride_x86_64.AppImage',
  'windows-x86_64': 'Stride_x86_64-setup.exe',
}

for (const platform of REQUIRED_PLATFORMS) {
  if (!platforms[platform]) {
    console.error(
      `missing updater artifact for ${platform} in ${artifactsDir}\n` +
        `  expected ${ARTIFACT_SHAPES[platform]} (+ .sig)`,
    )
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
