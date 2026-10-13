import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { bodyWikilinks, headingText } from './note.ts'
import { writeSampleNotes } from './sample.ts'
import { listNoteFiles, readNoteFile } from './vault.ts'

describe('writeSampleNotes', () => {
  it('writes the three sample notes and does not duplicate them on a second call', async () => {
    const fs = new MemoryFileSystem('field-notes')
    await writeSampleNotes(fs)

    expect(await listNoteFiles(fs)).toEqual([
      'ada-lovelace.stride.json',
      'sample-project.stride.json',
      'welcome.stride.json',
    ])

    const ada = await readNoteFile(fs, 'ada-lovelace.stride.json', 'ada-lovelace')
    const project = await readNoteFile(fs, 'sample-project.stride.json', 'sample-project')
    const welcome = await readNoteFile(fs, 'welcome.stride.json', 'welcome')

    expect(ada.title).toBe('Ada Lovelace')
    expect(ada.type).toBe('Person')
    expect(headingText(ada.doc)).toBe('Ada Lovelace')
    expect(ada.doc.content?.map((node) => node.type)).toEqual(['heading', 'paragraph'])
    expect(ada.doc.content?.[1]?.content?.map((node) => node.type)).toEqual(['text'])

    expect(project.title).toBe('Sample project')
    expect(project.type).toBe('Project')
    expect(headingText(project.doc)).toBe('Sample project')
    expect(project.properties.related_to).toBe('[[Ada Lovelace]]')

    expect(welcome.title).toBe('Welcome')
    expect(welcome.type).toBe('Note')
    expect(headingText(welcome.doc)).toBe('Welcome')
    expect(welcome.doc.content?.[1]?.type).toBe('paragraph')
    expect(welcome.doc.content?.[1]?.content).toContainEqual({
      type: 'wikilink',
      attrs: { target: 'Sample project' },
    })
    expect(bodyWikilinks(welcome.doc)).toEqual(['Sample project'])

    const adaRaw = await fs.readText('ada-lovelace.stride.json')
    const projectRaw = await fs.readText('sample-project.stride.json')
    const welcomeRaw = await fs.readText('welcome.stride.json')
    expect(adaRaw.trimStart().startsWith('---')).toBe(false)
    expect((JSON.parse(adaRaw) as { format?: string }).format).toBe('tiptap')
    const kept = adaRaw.replace('Ada Lovelace wrote notes on the Analytical Engine.', 'Kept paragraph.')
    await fs.writeText('ada-lovelace.stride.json', kept)

    await writeSampleNotes(fs)

    expect(await listNoteFiles(fs)).toEqual([
      'ada-lovelace.stride.json',
      'sample-project.stride.json',
      'welcome.stride.json',
    ])
    expect(await fs.readText('ada-lovelace.stride.json')).toContain('Kept paragraph.')
    expect(await fs.readText('ada-lovelace.stride.json')).not.toContain('Analytical Engine')
    expect(await fs.readText('sample-project.stride.json')).toBe(projectRaw)
    expect(await fs.readText('welcome.stride.json')).toBe(welcomeRaw)
  })
})
