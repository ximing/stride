import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { buildGraph, groupByType, relationsOf } from './graph.ts'
import type { TipTapNode } from './note.ts'
import { loadNotes, notePath, saveNote } from './vault.ts'

function doc(text: string, links: string[] = []): TipTapNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text },
          ...links.map((target) => ({ type: 'wikilink', attrs: { target } })),
        ],
      },
    ],
  }
}

describe('relationships and inbox', () => {
  it('derives inverse has, symmetric related_to, custom links, backlinks, inbox, and type groups', async () => {
    const files = new MemoryFileSystem('/tmp/stride-graph-folder')
    await saveNote(files, {
      id: 'parent',
      title: 'Parent',
      type: 'project',
      properties: {},
      doc: doc('parent body'),
    })
    await saveNote(files, {
      id: 'child',
      title: 'Child',
      type: 'note',
      properties: { belongs_to: ['[[Parent]]'], supports: ['[[Peer]]'] },
      doc: doc('child mentions ', ['Parent']),
    })
    await saveNote(files, {
      id: 'peer',
      title: 'Peer',
      type: 'note',
      properties: { related_to: ['[[Child]]'] },
      doc: doc('peer body'),
    })
    await saveNote(files, {
      id: 'loose',
      title: 'Loose',
      type: 'note',
      properties: { status: 'open' },
      doc: doc('no links yet'),
    })

    const notes = ['parent', 'child', 'peer', 'loose'].map(async (id) => {
      const raw = await files.readText(`${id}.stride.json`)
      return JSON.parse(raw) as { properties: Record<string, unknown> }
    })
    const stored = await Promise.all(notes)
    expect(stored[0]?.properties.has).toBeUndefined()
    expect(JSON.stringify(stored[0]?.properties)).not.toContain('Child')

    const loaded = await loadNotes(files)
    const graph = buildGraph(loaded)

    const parent = relationsOf(graph, 'parent')
    expect(parent.shown.some((link) => link.field === 'has' && link.targetId === 'child' && link.derived)).toBe(true)
    expect(parent.backlinks.some((link) => link.sourceId === 'child')).toBe(true)

    const child = relationsOf(graph, 'child')
    expect(child.shown.some((link) => link.field === 'belongs_to' && link.targetId === 'parent')).toBe(true)
    expect(child.shown.some((link) => link.field === 'body' && link.targetId === 'parent' && !link.derived)).toBe(true)
    expect(child.shown.some((link) => link.field === 'related_to' && link.targetId === 'peer')).toBe(true)
    expect(child.shown.some((link) => link.field === 'supports' && link.targetId === 'peer' && !link.derived)).toBe(true)
    expect(parent.backlinks.some((link) => link.sourceId === 'child' && link.via === 'body')).toBe(true)

    const peer = relationsOf(graph, 'peer')
    expect(peer.shown.some((link) => link.field === 'related_to' && link.targetId === 'child')).toBe(true)
    expect(peer.shown.some((link) => link.field === 'supports' && link.targetId === 'child' && link.derived)).toBe(true)

    expect(graph.inbox.map((note) => note.id).sort()).toEqual(['loose', 'parent'])

    const linked = loaded.find((note) => note.id === 'loose')!
    linked.properties = { ...linked.properties, belongs_to: ['[[Parent]]'] }
    await saveNote(files, linked)
    const after = buildGraph(await loadNotes(files))
    expect(after.inbox.map((note) => note.id)).not.toContain('loose')
    expect(after.inbox.map((note) => note.id)).toContain('parent')

    const sameFolder = loaded.filter((note) => note.id === 'parent' || note.id === 'child')
    expect(notePath('parent')).toBe('parent.stride.json')
    expect(notePath('child')).toBe('child.stride.json')
    const groups = groupByType(sameFolder)
    expect(groups.get('project')?.map((note) => note.id)).toEqual(['parent'])
    expect(groups.get('note')?.map((note) => note.id)).toEqual(['child'])
    expect([...groups.keys()]).not.toContain('stride-graph-folder')
  })

  it('lists a body wikilink on the source and leaves inbox based on properties', () => {
    const notes = [
      {
        id: 'loose',
        title: 'Loose',
        type: 'note',
        properties: {},
        doc: doc('see ', ['Parent', 'Ghost']),
      },
      {
        id: 'parent',
        title: 'Parent',
        type: 'project',
        properties: {},
        doc: doc('parent body'),
      },
    ]
    const graph = buildGraph(notes)
    expect(relationsOf(graph, 'loose').shown).toEqual([
      { field: 'body', targetId: 'parent', label: 'Parent', derived: false },
    ])
    expect(relationsOf(graph, 'parent').shown).toEqual([])
    expect(relationsOf(graph, 'parent').backlinks).toEqual([{ sourceId: 'loose', via: 'body' }])
    expect(graph.inbox.map((note) => note.id).sort()).toEqual(['loose', 'parent'])
  })
})
