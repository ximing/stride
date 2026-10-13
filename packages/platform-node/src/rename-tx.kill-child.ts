import { createNote } from '../../core/src/note.ts'
import { rewriteVaultLinks } from '../../core/src/rename-tx.ts'
import { writeNoteFile } from '../../core/src/vault.ts'
import { NodeFileSystem } from './fs.ts'

const dir = process.env.STRIDE_RENAME_DIR
if (!dir) throw new Error('STRIDE_RENAME_DIR is required')

const fs = new NodeFileSystem(dir)

const a = createNote('a', 'A')
a.properties = { related_to: '[[Old Title]]' }
await writeNoteFile(fs, 'a.stride.json', a)

const b = createNote('b', 'B')
b.doc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'see [[Old Title]]' }],
    },
  ],
}
await writeNoteFile(fs, 'b.stride.json', b)

if (process.env.STRIDE_RENAME_CRASH === '1') {
  await rewriteVaultLinks(
    fs,
    { fromTitle: 'Old Title', toTitle: 'New Title', fromId: 'old-title', toId: 'new-title' },
    {
      afterFile: (index) => {
        if (index === 0) process.exit(137)
      },
    },
  )
}
