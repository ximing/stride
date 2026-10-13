import { observer, register, resolve, useService } from '@rabjs/react'
import { relationsOf, buildGraph } from '@stride/core/graph'
import type { StrideNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from './panels.service'
import { VaultService } from './vault.service'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function sample(id: string, title: string): StrideNote {
  return {
    id,
    title,
    type: 'note',
    properties: {},
    doc: { type: 'doc', content: [{ type: 'paragraph' }] },
  }
}

describe('VaultService', () => {
  it('re-renders an observer when the service changes', async () => {
    register(VaultService)
    const service = resolve(VaultService)
    const View = observer(function View() {
      const vault = useService(VaultService)
      return <output>{vault.pathDraft}</output>
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<View />)
    })
    expect(host.textContent).toBe('')
    await act(async () => {
      service.setPathDraft('field-notes')
    })
    expect(host.textContent).toBe('field-notes')
    root.unmount()
    host.remove()
  })

  it('keeps a spaced title and does not rewrite a partial wikilink', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    register(VaultService)
    const vault = resolve(VaultService)
    const parent = sample('other-note', 'Other note')
    const child = sample('child', 'Child')
    vault.notes = [parent, child]
    vault.activeId = 'child'
    let shown = ''
    for (const ch of '[[Other note]]') {
      vault.updateProperty('belongs_to', shown + ch)
      shown = vault.propertyText('belongs_to')
    }
    expect(shown).toBe('[[Other note]]')
    vault.updateProperty('belongs_to', '[[')
    expect(vault.propertyText('belongs_to')).toBe('[[')
    vault.updateProperty('belongs_to', '[[Other note]]')
    const graph = buildGraph(vault.notes)
    expect(relationsOf(graph, 'child').shown.some((link) => link.targetId === 'other-note' && link.field === 'belongs_to')).toBe(true)
    expect(relationsOf(graph, 'other-note').shown.some((link) => link.field === 'has' && link.derived)).toBe(true)
  })

  it('flushes a pending edit before commit and adopts resolved notes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/git/commit')) {
        order.push('commit')
        return json({ output: 'ok' })
      }
      if (url.includes('/api/notes/')) {
        order.push(`save:${JSON.parse(String(init?.body)).note.title}`)
        return json(JSON.parse(String(init?.body)).note)
      }
      if (url.includes('/api/git/resolve')) {
        order.push('resolve')
        const chosen = sample('status', 'Chosen side')
        chosen.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SIDE_A' }] }] }
        return json({ notes: [chosen] })
      }
      if (url.includes('/api/git/')) return json({ repo: true, porcelain: '', clean: true, diff: '', history: [] })
      return json({})
    }))
    register(VaultService)
    register(GitService)
    const vault = resolve(VaultService)
    const git = resolve(GitService)
    vault.notes = [sample('status', 'Old title')]
    vault.activeId = 'status'
    vault.updateTitle('Flushed title')
    await git.commit()
    expect(order[0]).toBe('save:Flushed title')
    expect(order[1]).toBe('commit')

    order.length = 0
    vault.updateTitle('stale editor')
    await git.keepSide('status', 'theirs')
    expect(order).toEqual(['resolve'])
    expect(vault.active?.title).toBe('Chosen side')
    expect(vault.docEpoch).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(order).toEqual(['resolve'])
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
