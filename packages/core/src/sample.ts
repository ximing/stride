import type { FileSystemBackend } from '@stride/platform'
import type { StrideNote, TipTapNode } from './note.ts'
import { notePath, writeNoteFile } from './vault.ts'

function sampleDoc(title: string, paragraph: TipTapNode[]): TipTapNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: title }],
      },
      { type: 'paragraph', content: paragraph },
    ],
  }
}

const SAMPLE_NOTES: StrideNote[] = [
  {
    id: 'ada-lovelace',
    title: 'Ada Lovelace',
    type: 'Person',
    properties: {},
    doc: sampleDoc('Ada Lovelace', [
      { type: 'text', text: 'Ada Lovelace wrote notes on the Analytical Engine.' },
    ]),
  },
  {
    id: 'sample-project',
    title: 'Sample project',
    type: 'Project',
    properties: { related_to: '[[Ada Lovelace]]' },
    doc: sampleDoc('Sample project', [
      { type: 'text', text: 'A short sample project.' },
    ]),
  },
  {
    id: 'welcome',
    title: 'Welcome',
    type: 'Note',
    properties: {},
    doc: sampleDoc('Welcome', [
      { type: 'text', text: 'Start with ' },
      { type: 'wikilink', attrs: { target: 'Sample project' } },
      { type: 'text', text: '.' },
    ]),
  },
]

export async function writeSampleNotes(fs: FileSystemBackend): Promise<void> {
  for (const note of SAMPLE_NOTES) {
    const file = notePath(note.id)
    if (await fs.stat(file)) continue
    await writeNoteFile(fs, file, note)
  }
}
