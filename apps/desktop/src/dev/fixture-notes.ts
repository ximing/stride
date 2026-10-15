// DEV-ONLY fixture generator for `?fixture=memory&seed=N` performance testing.
// VaultService dynamic-imports this module only under `import.meta.env.DEV`,
// so it never lands in production bundles. Also used by perf/unit tests that
// need large synthetic note sets.

import type { FileSystemBackend } from '@stride/platform'
import type { StrideNote } from '@stride/core/note'
import { notePath, writeNoteFile } from '../../../../packages/core/src/vault'

/** Deterministic PRNG (mulberry32) so fixture vaults are reproducible. */
export function mulberry32(seed: number): () => number {
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
  'ember', 'circuit', 'meadow', 'quartz', 'tide', 'ledger', 'sparrow', 'kiln',
  'orchard', 'compass', 'lantern', 'birch', 'cinder', 'delta', 'fable', 'grove',
]

const FIXTURE_TYPES = ['note', 'note', 'note', 'Journal', 'Project', 'Person']
const FIXTURE_STATUSES = ['Open', 'Doing', 'Done']

function fixtureBody(title: string, random: () => number): StrideNote['doc'] {
  const sentence = () =>
    Array.from({ length: 8 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ')
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] },
      { type: 'paragraph', content: [{ type: 'text', text: `${sentence()}.` }] },
      { type: 'paragraph', content: [{ type: 'text', text: `${sentence()}.` }] },
    ],
  }
}

/** Build one synthetic note without touching a backend. */
export function fixtureNote(index: number, random: () => number): StrideNote {
  const id = `fixture-${String(index).padStart(5, '0')}`
  const word = WORDS[Math.floor(random() * WORDS.length)]
  const title = `Fixture note ${index} ${word}`
  const type = FIXTURE_TYPES[Math.floor(random() * FIXTURE_TYPES.length)] ?? 'note'
  const properties: StrideNote['properties'] = {}
  if (random() < 0.35) properties.status = FIXTURE_STATUSES[Math.floor(random() * FIXTURE_STATUSES.length)] ?? 'Open'
  return { id, title, type, properties, doc: fixtureBody(title, random) }
}

/** Write `count` synthetic notes into the backend. Existing files are skipped. */
export async function writeFixtureNotes(
  fs: FileSystemBackend,
  count: number,
  seed = 42,
): Promise<number> {
  const random = mulberry32(seed)
  let written = 0
  for (let index = 1; index <= count; index += 1) {
    const note = fixtureNote(index, random)
    const file = notePath(note.id)
    if (await fs.stat(file)) continue
    await writeNoteFile(fs, file, note)
    written += 1
  }
  return written
}
