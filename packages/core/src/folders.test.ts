import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { createNote } from './note.ts'
import { readNoteFile, writeNoteFile } from './vault.ts'
import { createFolder, deleteFolder, listFolders, moveNotePath, renameFolder } from './folders.ts'

describe('folders', () => {
  it('lists nested directories and skips dot dirs, .git, .stride, and node_modules', async () => {
    const fs = new MemoryFileSystem('memory')
    await fs.mkdir('.git')
    await fs.mkdir('.stride')
    await fs.mkdir('.hidden/nope')
    await fs.mkdir('node_modules/pkg')
    await fs.mkdir('zeta')
    await fs.mkdir('box/inner')
    await fs.writeText('box/loose.txt', 'x')
    expect(await listFolders(fs)).toEqual(['box', 'box/inner', 'zeta'])
  })

  it('rejects an empty, parent, or absolute folder path', async () => {
    const fs = new MemoryFileSystem('memory')
    await expect(createFolder(fs, '   ')).rejects.toThrow('Invalid folder')
    await expect(createFolder(fs, 'a/../b')).rejects.toThrow('Invalid folder')
    await expect(createFolder(fs, '/abs')).rejects.toThrow('Invalid folder')
    await expect(renameFolder(fs, 'box', '..')).rejects.toThrow('Invalid folder')
    await expect(renameFolder(fs, '', 'box')).rejects.toThrow('Invalid folder')
    expect(await listFolders(fs)).toEqual([])
  })

  it('creates and renames a folder', async () => {
    const fs = new MemoryFileSystem('memory')
    await createFolder(fs, '  box  ')
    expect(await fs.stat('box')).toMatchObject({ kind: 'directory' })
    await renameFolder(fs, 'box', 'crate')
    expect(await fs.stat('box')).toBeNull()
    expect(await fs.stat('crate')).toMatchObject({ kind: 'directory' })
    expect(await listFolders(fs)).toEqual(['crate'])
  })

  it('moves Alpha into box and keeps the title and related_to', async () => {
    const fs = new MemoryFileSystem('memory')
    const note = createNote('alpha', 'Alpha')
    note.properties.related_to = '[[Alpha]]'
    await writeNoteFile(fs, 'alpha.stride.json', note)
    await createFolder(fs, 'box')

    const toId = await moveNotePath(fs, 'alpha', 'box')

    expect(toId).toBe('box/alpha')
    expect(await fs.stat('alpha.stride.json')).toBeNull()
    expect(await fs.stat('box/alpha.stride.json')).not.toBeNull()
    const moved = await readNoteFile(fs, 'box/alpha.stride.json', toId)
    expect(moved.title).toBe('Alpha')
    expect(moved.properties.related_to).toBe('[[Alpha]]')
  })

  it('throws when the folder still has a note and leaves the file in place', async () => {
    const fs = new MemoryFileSystem('memory')
    const note = createNote('box/alpha', 'Alpha')
    note.properties.related_to = '[[Alpha]]'
    await writeNoteFile(fs, 'box/alpha.stride.json', note)

    await expect(deleteFolder(fs, 'box', ['box/alpha'])).rejects.toThrow('Folder is not empty')
    expect(await fs.stat('box/alpha.stride.json')).not.toBeNull()
    const still = await readNoteFile(fs, 'box/alpha.stride.json', 'box/alpha')
    expect(still.title).toBe('Alpha')
    expect(still.properties.related_to).toBe('[[Alpha]]')
  })

  it('removes an empty folder', async () => {
    const fs = new MemoryFileSystem('memory')
    await createFolder(fs, 'box')
    await writeNoteFile(fs, 'alpha.stride.json', createNote('alpha', 'Alpha'))
    await deleteFolder(fs, 'box', ['alpha'])
    expect(await fs.stat('box')).toBeNull()
    expect(await fs.stat('alpha.stride.json')).not.toBeNull()
  })

  it('refuses to land on a note that is already there', async () => {
    const fs = new MemoryFileSystem('memory')
    await writeNoteFile(fs, 'alpha.stride.json', createNote('alpha', 'Alpha'))
    await writeNoteFile(fs, 'box/alpha.stride.json', createNote('box/alpha', 'Other'))
    await expect(moveNotePath(fs, 'alpha', 'box')).rejects.toThrow('A note is already there')
    expect(await fs.stat('alpha.stride.json')).not.toBeNull()
    expect((await readNoteFile(fs, 'box/alpha.stride.json', 'box/alpha')).title).toBe('Other')
  })

  it('moves a note back to the vault root', async () => {
    const fs = new MemoryFileSystem('memory')
    const note = createNote('box/alpha', 'Alpha')
    note.properties.related_to = '[[Alpha]]'
    await writeNoteFile(fs, 'box/alpha.stride.json', note)
    expect(await moveNotePath(fs, 'box/alpha', '')).toBe('alpha')
    expect(await fs.stat('box/alpha.stride.json')).toBeNull()
    const moved = await readNoteFile(fs, 'alpha.stride.json', 'alpha')
    expect(moved.title).toBe('Alpha')
    expect(moved.properties.related_to).toBe('[[Alpha]]')
  })
})
