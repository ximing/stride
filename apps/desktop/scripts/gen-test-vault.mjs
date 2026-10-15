#!/usr/bin/env node
// Generate a Stride vault of N synthetic notes for performance testing.
//
// Usage:
//   node scripts/gen-test-vault.mjs <target-dir> [--count 10000] [--seed 42]
//
// The output is a real on-disk vault (marker + *.stride.json files) that the
// desktop app can open via "Open vault". Node-only script: it never ships in
// the webview bundle. Self-contained on purpose — no workspace imports — so it
// runs with plain `node` without a build step.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  'garden', 'ledger', 'harbor', 'signal', 'moss', 'anchor', 'copper', 'willow',
  'ember', 'circuit', 'meadow', 'quartz', 'tide', 'sparrow', 'kiln',
  'orchard', 'compass', 'lantern', 'birch', 'cinder', 'delta', 'fable', 'grove',
]
const TYPES = ['note', 'note', 'note', 'Journal', 'Project', 'Person']
const STATUSES = ['Open', 'Doing', 'Done']

function parseArgs(argv) {
  const args = { dir: '', count: 10_000, seed: 42 }
  const rest = [...argv]
  while (rest.length > 0) {
    const token = rest.shift()
    if (token === '--count') args.count = Number(rest.shift())
    else if (token === '--seed') args.seed = Number(rest.shift())
    else if (token && !token.startsWith('--') && !args.dir) args.dir = token
    else if (token === '--help' || token === '-h') {
      console.log('Usage: node scripts/gen-test-vault.mjs <dir> [--count 10000] [--seed 42]')
      process.exit(0)
    }
  }
  if (!args.dir || !Number.isFinite(args.count) || args.count <= 0) {
    console.error('Usage: node scripts/gen-test-vault.mjs <dir> [--count 10000] [--seed 42]')
    process.exit(1)
  }
  return args
}

function fixtureNote(index, random) {
  const id = `fixture-${String(index).padStart(5, '0')}`
  const word = WORDS[Math.floor(random() * WORDS.length)]
  const title = `Fixture note ${index} ${word}`
  const type = TYPES[Math.floor(random() * TYPES.length)]
  const properties = {}
  if (random() < 0.35) properties.status = STATUSES[Math.floor(random() * STATUSES.length)]
  const sentence = () => Array.from({ length: 8 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ')
  return {
    id,
    file: {
      format: 'tiptap',
      title,
      type,
      properties,
      doc: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] },
          { type: 'paragraph', content: [{ type: 'text', text: `${sentence()}.` }] },
          { type: 'paragraph', content: [{ type: 'text', text: `${sentence()}.` }] },
        ],
      },
    },
  }
}

const { dir, count, seed } = parseArgs(process.argv.slice(2))
const root = path.resolve(dir)
await mkdir(path.join(root, '.stride'), { recursive: true })
await writeFile(
  path.join(root, '.stride', 'vault.json'),
  `${JSON.stringify({ kind: 'stride-vault', version: 1 }, null, 2)}\n`,
)

const random = mulberry32(seed)
const started = Date.now()
for (let index = 1; index <= count; index += 1) {
  const note = fixtureNote(index, random)
  await writeFile(path.join(root, `${note.id}.stride.json`), `${JSON.stringify(note.file, null, 2)}\n`)
}
console.log(`Wrote ${count} notes to ${root} in ${Date.now() - started}ms`)
