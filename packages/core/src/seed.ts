import type { FileSystemBackend } from '@stride/platform'
import { type NoteProperty, type StrideNote, type TipTapNode } from './note.ts'
import { isBroadPersonalRoot } from './roots.ts'
import { isDedicatedVault, markDedicatedVault, notePath, writeNoteFile } from './vault.ts'

export const DEDICATED_FOLDER_ERROR =
  'Choose a dedicated vault folder. This path looks like a broad personal folder.'

interface SeedType {
  id: string
  title: string
  blurb: string
  properties: Record<string, NoteProperty>
}

const SEED_TYPES: SeedType[] = [
  {
    id: 'note',
    title: 'Note',
    blurb: 'A freeform note.',
    properties: {
      _icon: 'note',
      _color: 'gray',
      _order: '10',
      _sidebar_label: 'Notes',
      visible: 'true',
    },
  },
  {
    id: 'project',
    title: 'Project',
    blurb: 'A project you are working on.',
    properties: {
      _icon: 'briefcase',
      _color: 'blue',
      _order: '20',
      _sidebar_label: 'Projects',
      visible: 'true',
    },
  },
  {
    id: 'person',
    title: 'Person',
    blurb: 'A person you keep notes about.',
    properties: {
      _icon: 'user',
      _color: 'teal',
      _order: '30',
      _sidebar_label: 'People',
      visible: 'true',
    },
  },
]

function seedDocument(spec: SeedType): StrideNote {
  const doc: TipTapNode = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: spec.title }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: spec.blurb }],
      },
    ],
  }
  return {
    id: spec.id,
    title: spec.title,
    type: 'Type',
    properties: spec.properties,
    doc,
  }
}

export async function initializeVault(fs: FileSystemBackend, homeDir: string): Promise<void> {
  if (isBroadPersonalRoot(fs.rootLabel, homeDir)) {
    throw new Error(DEDICATED_FOLDER_ERROR)
  }
  if (!(await isDedicatedVault(fs))) await markDedicatedVault(fs)
  for (const spec of SEED_TYPES) {
    const file = notePath(spec.id)
    if (await fs.stat(file)) continue
    await writeNoteFile(fs, file, seedDocument(spec))
  }
}
