import { MemoryFileSystem } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { createNote, type TipTapNode } from './note.ts'
import { recoverRename, rewriteVaultLinks, type RenameChange } from './rename-tx.ts'
import { readNoteFile, writeNoteFile } from './vault.ts'

const change: RenameChange = {
  fromTitle: 'Old Title',
  toTitle: 'New Title',
  fromId: 'old-title',
  toId: 'new-title',
}

function linkerDoc(): TipTapNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'wikilink', attrs: { target: 'Old Title', alias: 'keep' } },
          { type: 'text', text: 'see [[old-title]] and [[Old Title Extra]]' },
        ],
      },
    ],
  }
}

function textOf(doc: TipTapNode): string {
  const parts: string[] = []
  const walk = (node: TipTapNode | undefined) => {
    if (!node) return
    if (node.type === 'text' && node.text) parts.push(node.text)
    node.content?.forEach(walk)
  }
  walk(doc)
  return parts.join('')
}

function wikilinkAttrs(doc: TipTapNode): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined
  const walk = (node: TipTapNode | undefined) => {
    if (!node || found) return
    if (node.type === 'wikilink') found = node.attrs
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

async function seed(fs: MemoryFileSystem): Promise<void> {
  const old = createNote('old-title', 'Old Title')
  const linker = createNote('linker', 'Linker')
  linker.properties = {
    related_to: '[[Old Title]]',
    also: ['[[Old Title]]', '[[Other]]'],
    count: 1,
  }
  linker.doc = linkerDoc()
  const other = createNote('other', 'Other')
  other.properties = { related_to: '[[Old Title Extra]]' }
  await writeNoteFile(fs, 'old-title.stride.json', old)
  await writeNoteFile(fs, 'linker.stride.json', linker)
  await writeNoteFile(fs, 'other.stride.json', other)
}

describe('rewriteVaultLinks', () => {
  it('rewrites complete wikilink tokens and stays idempotent', async () => {
    const fs = new MemoryFileSystem('rename')
    await seed(fs)

    await rewriteVaultLinks(fs, change)

    const linker = await readNoteFile(fs, 'linker.stride.json', 'linker')
    const other = await readNoteFile(fs, 'other.stride.json', 'other')
    const old = await readNoteFile(fs, 'old-title.stride.json', 'old-title')
    const text = textOf(linker.doc)

    expect(linker.properties.related_to).toBe('[[New Title]]')
    expect(linker.properties.also).toEqual(['[[New Title]]', '[[Other]]'])
    expect(linker.properties.count).toBe(1)
    expect(wikilinkAttrs(linker.doc)?.target).toBe('New Title')
    expect(wikilinkAttrs(linker.doc)?.alias).toBe('keep')
    expect(text).toContain('[[New Title]]')
    expect(text).toContain('[[Old Title Extra]]')
    expect(text).not.toContain('[[old-title]]')
    expect(other.properties.related_to).toBe('[[Old Title Extra]]')
    expect(other.title).toBe('Other')
    expect(old.title).toBe('Old Title')
    expect(await fs.stat('.stride/rename-tx/journal.json')).toBeNull()
    expect(await fs.stat('linker.stride.json.rename-tmp')).toBeNull()
    expect(await fs.stat('old-title.stride.json.rename-tmp')).toBeNull()
    expect(await fs.stat('other.stride.json.rename-tmp')).toBeNull()

    const before = {
      linker: await fs.readText('linker.stride.json'),
      other: await fs.readText('other.stride.json'),
      old: await fs.readText('old-title.stride.json'),
    }
    await rewriteVaultLinks(fs, change)
    await recoverRename(fs)
    expect(await fs.readText('linker.stride.json')).toBe(before.linker)
    expect(await fs.readText('other.stride.json')).toBe(before.other)
    expect(await fs.readText('old-title.stride.json')).toBe(before.old)
  })

  it('rewrites id links when the title string stays the same', async () => {
    const fs = new MemoryFileSystem('same-title')
    const note = createNote('status-2', 'Status')
    const linker = createNote('linker', 'Linker')
    linker.properties = {
      related_to: '[[status-2]]',
      also: ['[[Status]]', '[[status-2]]'],
      count: 1,
    }
    linker.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { target: 'status-2', alias: 'keep' } },
            { type: 'wikilink', attrs: { target: 'Status' } },
            { type: 'text', text: 'see [[status-2]] and [[Status]] and [[status-2 extra]]' },
          ],
        },
      ],
    }
    await writeNoteFile(fs, 'status-2.stride.json', note)
    await writeNoteFile(fs, 'linker.stride.json', linker)

    const idOnly: RenameChange = {
      fromTitle: 'Status',
      toTitle: 'Status',
      fromId: 'status-2',
      toId: 'status',
    }
    await rewriteVaultLinks(fs, idOnly)

    const saved = await readNoteFile(fs, 'linker.stride.json', 'linker')
    const nodes = saved.doc.content?.[0]?.content ?? []
    expect(saved.properties.related_to).toBe('[[status]]')
    expect(saved.properties.also).toEqual(['[[Status]]', '[[status]]'])
    expect(saved.properties.count).toBe(1)
    expect(saved.title).toBe('Linker')
    expect(nodes[0]?.attrs).toEqual({ target: 'status', alias: 'keep' })
    expect(nodes[1]?.attrs).toEqual({ target: 'Status' })
    expect(textOf(saved.doc)).toBe('see [[status]] and [[Status]] and [[status-2 extra]]')
    expect((await readNoteFile(fs, 'status-2.stride.json', 'status-2')).title).toBe('Status')
    expect(await fs.stat('.stride/rename-tx/journal.json')).toBeNull()

    const before = await fs.readText('linker.stride.json')
    await rewriteVaultLinks(fs, idOnly)
    expect(await fs.readText('linker.stride.json')).toBe(before)
  })

  it('leaves links alone when the title and id are unchanged', async () => {
    const fs = new MemoryFileSystem('unchanged')
    const linker = createNote('linker', 'Linker')
    linker.properties = { related_to: '[[status-2]]', also: '[[Status]]' }
    linker.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { target: 'status-2', alias: 'keep' } },
            { type: 'text', text: '[[status-2]] [[Status]]' },
          ],
        },
      ],
    }
    await writeNoteFile(fs, 'linker.stride.json', linker)
    const before = await fs.readText('linker.stride.json')

    await rewriteVaultLinks(fs, {
      fromTitle: 'Status',
      toTitle: 'Status',
      fromId: 'status-2',
      toId: 'status-2',
    })

    expect(await fs.readText('linker.stride.json')).toBe(before)
    expect(await fs.stat('.stride/rename-tx/journal.json')).toBeNull()
  })

  it('does not fold case or whitespace when the title changes', async () => {
    const fs = new MemoryFileSystem('exact')
    const linker = createNote('linker', 'Linker')
    linker.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { target: 'old title' } },
            { type: 'text', text: '[[OLD TITLE]] [[Old  Title]] [[Old Title]] [[old-title]]' },
          ],
        },
      ],
    }
    await writeNoteFile(fs, 'linker.stride.json', linker)

    await rewriteVaultLinks(fs, change)

    const saved = await readNoteFile(fs, 'linker.stride.json', 'linker')
    expect(wikilinkAttrs(saved.doc)?.target).toBe('old title')
    expect(textOf(saved.doc)).toBe('[[OLD TITLE]] [[Old  Title]] [[New Title]] [[New Title]]')
  })

  it('rejects a corrupt journal without removing notes', async () => {
    const fs = new MemoryFileSystem('corrupt')
    await seed(fs)
    await fs.writeText('.stride/rename-tx/journal.json', 'not-json')

    await expect(recoverRename(fs)).rejects.toThrow('Corrupt rename journal')
    expect(await fs.stat('linker.stride.json')).not.toBeNull()
    expect(await fs.readText('.stride/rename-tx/journal.json')).toBe('not-json')
  })
})
