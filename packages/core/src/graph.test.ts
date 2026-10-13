import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGraph, groupByType, relationsOf } from './graph.ts'
import { loadNotes, saveNote } from './vault.ts'
import type { TipTapNode } from './note.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-graph-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

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
  it('derives inverse has, symmetric related_to, custom links, backlinks, inbox, and type groups', () => {
    const vault = tempDir()
    saveNote(vault, {
      id: 'parent',
      title: 'Parent',
      type: 'project',
      properties: {},
      doc: doc('parent body'),
    })
    saveNote(vault, {
      id: 'child',
      title: 'Child',
      type: 'note',
      properties: { belongs_to: ['[[Parent]]'], supports: ['[[Peer]]'] },
      doc: doc('child mentions ', ['Parent']),
    })
    saveNote(vault, {
      id: 'peer',
      title: 'Peer',
      type: 'note',
      properties: { related_to: ['[[Child]]'] },
      doc: doc('peer body'),
    })
    saveNote(vault, {
      id: 'loose',
      title: 'Loose',
      type: 'note',
      properties: { status: 'open' },
      doc: doc('no links yet'),
    })

    const notes = ['parent', 'child', 'peer', 'loose'].map((id) => {
      const raw = fs.readFileSync(path.join(vault, `${id}.stride.json`), 'utf8')
      return JSON.parse(raw) as { properties: Record<string, unknown> }
    })
    expect(notes[0]?.properties.has).toBeUndefined()
    expect(JSON.stringify(notes[0]?.properties)).not.toContain('Child')

    const loaded = loadNotes(vault)
    const graph = buildGraph(loaded)

    const parent = relationsOf(graph, 'parent')
    expect(parent.shown.some((link) => link.field === 'has' && link.targetId === 'child' && link.derived)).toBe(true)
    expect(parent.backlinks.some((link) => link.sourceId === 'child')).toBe(true)

    const child = relationsOf(graph, 'child')
    expect(child.shown.some((link) => link.field === 'belongs_to' && link.targetId === 'parent')).toBe(true)
    expect(child.shown.some((link) => link.field === 'related_to' && link.targetId === 'peer')).toBe(true)
    expect(child.shown.some((link) => link.field === 'supports' && link.targetId === 'peer' && !link.derived)).toBe(true)

    const peer = relationsOf(graph, 'peer')
    expect(peer.shown.some((link) => link.field === 'related_to' && link.targetId === 'child')).toBe(true)
    expect(peer.shown.some((link) => link.field === 'supports' && link.targetId === 'child' && link.derived)).toBe(true)

    expect(graph.inbox.map((note) => note.id).sort()).toEqual(['loose', 'parent'])

    const linked = loaded.find((note) => note.id === 'loose')!
    linked.properties = { ...linked.properties, belongs_to: ['[[Parent]]'] }
    saveNote(vault, linked)
    const after = buildGraph(loadNotes(vault))
    expect(after.inbox.map((note) => note.id)).not.toContain('loose')
    expect(after.inbox.map((note) => note.id)).toContain('parent')

    const sameFolder = loaded.filter((note) => note.id === 'parent' || note.id === 'child')
    expect(path.dirname(path.join(vault, 'parent.stride.json'))).toBe(path.dirname(path.join(vault, 'child.stride.json')))
    const groups = groupByType(sameFolder)
    expect(groups.get('project')?.map((note) => note.id)).toEqual(['parent'])
    expect(groups.get('note')?.map((note) => note.id)).toEqual(['child'])
    expect([...groups.keys()]).not.toContain(path.basename(vault))
  })
})
