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

  it('rejects a corrupt journal without removing notes', async () => {
    const fs = new MemoryFileSystem('corrupt')
    await seed(fs)
    await fs.writeText('.stride/rename-tx/journal.json', 'not-json')

    await expect(recoverRename(fs)).rejects.toThrow('Corrupt rename journal')
    expect(await fs.stat('linker.stride.json')).not.toBeNull()
    expect(await fs.readText('.stride/rename-tx/journal.json')).toBe('not-json')
  })
})
