import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { headingText } from './note.ts'
import { DEDICATED_FOLDER_ERROR, initializeVault } from './seed.ts'
import { listNoteFiles, readNoteFile } from './vault.ts'

const HOME = '/Users/stride'

describe('initializeVault', () => {
  it('writes the vault marker and three type notes, and does not duplicate them', async () => {
    const fs = new MemoryFileSystem('field-notes')
    await initializeVault(fs, HOME)

    const marker = JSON.parse(await fs.readText('.stride/vault.json')) as { kind?: string; version?: number }
    expect(marker.kind).toBe('stride-vault')
    expect(marker.version).toBe(1)
    expect(await listNoteFiles(fs)).toEqual([
      'note.stride.json',
      'person.stride.json',
      'project.stride.json',
    ])

    const note = await readNoteFile(fs, 'note.stride.json', 'note')
    const project = await readNoteFile(fs, 'project.stride.json', 'project')
    const person = await readNoteFile(fs, 'person.stride.json', 'person')
    expect(note.title).toBe('Note')
    expect(project.title).toBe('Project')
    expect(person.title).toBe('Person')
    expect(note.type).toBe('Type')
    expect(project.type).toBe('Type')
    expect(person.type).toBe('Type')
    expect(headingText(note.doc)).toBe('Note')
    expect(headingText(project.doc)).toBe('Project')
    expect(headingText(person.doc)).toBe('Person')
    expect(note.doc.content?.map((node) => node.type)).toEqual(['heading', 'paragraph'])
    expect(note.properties).toEqual({
      _icon: 'note',
      _color: 'gray',
      _order: '10',
      _sidebar_label: 'Notes',
      visible: 'true',
    })
    expect(project.properties._icon).toBe('briefcase')
    expect(project.properties._color).toBe('blue')
    expect(project.properties._order).toBe('20')
    expect(project.properties._sidebar_label).toBe('Projects')
    expect(project.properties.visible).toBe('true')
    expect(person.properties._icon).toBe('user')
    expect(person.properties._color).toBe('teal')
    expect(person.properties._order).toBe('30')
    expect(person.properties._sidebar_label).toBe('People')
    expect(person.properties.visible).toBe('true')
    const raw = await fs.readText('note.stride.json')
    expect(raw.trimStart().startsWith('---')).toBe(false)
    expect((JSON.parse(raw) as { format?: string }).format).toBe('tiptap')

    const custom = raw.replace('A freeform note.', 'Kept paragraph.')
    await fs.writeText('note.stride.json', custom)
    const withExtra = JSON.parse(await fs.readText('.stride/vault.json')) as { kind?: string }
    await fs.writeText('.stride/vault.json', `${JSON.stringify({ ...withExtra, extra: 'keep' }, null, 2)}\n`)
    await initializeVault(fs, HOME)

    expect(await listNoteFiles(fs)).toEqual([
      'note.stride.json',
      'person.stride.json',
      'project.stride.json',
    ])
    expect(await fs.readText('note.stride.json')).toContain('Kept paragraph.')
    expect(headingText((await readNoteFile(fs, 'note.stride.json', 'note')).doc)).toBe('Note')
    const again = JSON.parse(await fs.readText('.stride/vault.json')) as { kind?: string; extra?: string }
    expect(again.kind).toBe('stride-vault')
    expect(again.extra).toBe('keep')
    expect((await fs.readText('.gitignore')).split('\n').filter((line) => line === '.stride/vane/')).toEqual([
      '.stride/vane/',
    ])
  })

  it('refuses a broad personal root and writes nothing', async () => {
    for (const label of ['/Users/stride', '/Users/stride/Documents', 'Downloads']) {
      const fs = new MemoryFileSystem(label)
      await expect(initializeVault(fs, HOME)).rejects.toThrow(DEDICATED_FOLDER_ERROR)
      expect(await fs.stat('.stride/vault.json')).toBeNull()
      expect(await fs.stat('.gitignore')).toBeNull()
      expect(await fs.stat('note.stride.json')).toBeNull()
      expect(await fs.stat('project.stride.json')).toBeNull()
      expect(await fs.stat('person.stride.json')).toBeNull()
      expect(await fs.list('')).toEqual([])
    }
  })
})
