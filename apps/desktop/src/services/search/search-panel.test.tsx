import { register, resolve } from '@rabjs/react'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { noteIndex, type NoteIndex, type SearchQuery } from '@stride/core'
import { createNote, type StrideNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchPanel } from '../../ui/overlays/search-panel'
import { isSearchPanelShortcut, SearchPanelService } from './search-panel.service'
import { VaultService } from '../vault/vault.service'

function note(id: string, title: string, properties: StrideNote['properties'] = {}): StrideNote {
  const created = createNote(id, title)
  created.properties = { ...properties }
  return created
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

describe('search panel shortcut', () => {
  it('accepts meta or ctrl with shift, and rejects alt, bare find, and other keys', () => {
    expect(isSearchPanelShortcut(new KeyboardEvent('keydown', { key: 'f', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isSearchPanelShortcut(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isSearchPanelShortcut(new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isSearchPanelShortcut(new KeyboardEvent('keydown', { key: 'f', metaKey: true, shiftKey: true, altKey: true }))).toBe(false)
    expect(isSearchPanelShortcut(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))).toBe(false)
    expect(isSearchPanelShortcut(new KeyboardEvent('keydown', { key: 'f', shiftKey: true }))).toBe(false)
    expect(isSearchPanelShortcut(new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true }))).toBe(false)
  })
})

describe('search panel confirm', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    root?.unmount()
    host?.remove()
    root = null
    host = null
    vi.restoreAllMocks()
  })

  function setup(notes: StrideNote[]) {
    register(VaultService)
    register(SearchPanelService)
    const vault = resolve(VaultService)
    const panel = resolve(SearchPanelService)
    vault.phase = 'ready'
    vault.notes = notes
    vault.activeId = notes[0]?.id ?? ''
    Object.assign(vault, { index: null })
    return { vault, panel }
  }

  async function mount(notes: StrideNote[]) {
    const services = setup(notes)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<SearchPanel />)
    })
    return services
  }

  it('selects the chosen id, focuses the title, and does not jump the body', async () => {
    const { vault, panel } = setup([
      note('flow', '采购流程'),
      note('list', '采购清单'),
      note('arch', '旧采购', { archived: true }),
    ])
    const hits = await vault.queryRanked('采购')
    expect(hits.map((hit) => hit.id)).toEqual(['flow', 'list'])
    expect(hits[0]?.source).toBe('title')
    panel.show()
    await act(async () => {
      await panel.setQuery('采购')
    })
    expect(panel.results.map((hit) => hit.id)).toEqual(['flow', 'list'])
    panel.move(1)
    const select = vi.spyOn(vault, 'select')
    const jumped: unknown[] = []
    const onJump = (event: Event) => jumped.push((event as CustomEvent).detail)
    window.addEventListener('stride-search-jump', onJump)
    const input = document.createElement('input')
    input.dataset.testid = 'note-title'
    input.value = '采购清单'
    document.body.appendChild(input)
    try {
      await act(async () => {
        panel.confirm()
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
      })
      expect(select).toHaveBeenCalledWith('list')
      expect(panel.open).toBe(false)
      expect(vault.activeId).toBe('list')
      expect(document.activeElement).toBe(input)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('采购'.length)
      expect(jumped).toEqual([])
    } finally {
      window.removeEventListener('stride-search-jump', onJump)
      input.remove()
    }
  })

  it('jumps a body hit by title length plus the newline', async () => {
    const { vault, panel } = setup([note('body', '其他')])
    panel.show()
    panel.results = [{
      id: 'body',
      score: 4,
      snippet: '采购流程',
      source: 'body',
      offset: 6,
      length: 2,
    }]
    const select = vi.spyOn(vault, 'select')
    const jumped: unknown[] = []
    const onJump = (event: Event) => jumped.push((event as CustomEvent).detail)
    window.addEventListener('stride-search-jump', onJump)
    try {
      await act(async () => {
        panel.confirm()
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
      })
      expect(select).toHaveBeenCalledWith('body')
      expect(panel.open).toBe(false)
      expect(jumped).toEqual([{ offset: 6 - '其他'.length - 1, length: 2 }])
    } finally {
      window.removeEventListener('stride-search-jump', onJump)
    }
  })

  it('asks the index for text mode topK 30 and does not embed', async () => {
    const { vault } = setup([note('live', '会议纪要')])
    const calls: SearchQuery[] = []
    const index = noteIndex({
      async search(query: SearchQuery) {
        calls.push(query)
        return [{ id: 'live', score: 2, snippet: '会议纪要' }]
      },
      async upsert() {},
      async remove() {},
      async close() {},
    }, 0)
    Object.assign(vault, { index })
    try {
      const hits = await vault.queryRanked('会议')
      expect(calls).toEqual([{ text: '会议', topK: 30, mode: 'text' }])
      expect(hits[0]?.id).toBe('live')
      expect(hits[0]?.source).toBe('title')
      expect(calls[0]).not.toHaveProperty('vector')
    } finally {
      Object.assign(vault, { index: null })
      await (index as NoteIndex).close()
    }
  })

  it('shows the BM25 banner only while search is degraded', async () => {
    const { vault, panel } = await mount([note('meet', '会议纪要')])
    await act(async () => {
      panel.show()
    })
    expect(host?.querySelector('[data-testid="search-degraded"]')).toBeNull()
    await act(async () => {
      vault.searchDegraded = true
    })
    expect(host?.querySelector('[data-testid="search-degraded"]')?.textContent).toBe('Fell back to BM25')
    await act(async () => {
      vault.searchDegraded = false
    })
    expect(host?.querySelector('[data-testid="search-degraded"]')).toBeNull()
  })

  it('opens on cmd-shift-f, marks the query, and confirms the selected id', async () => {
    const { vault } = await mount([note('meet', '会议纪要'), note('other', '其他')])
    const select = vi.spyOn(vault, 'select')
    const ignored = press({ key: 'f', metaKey: true })
    expect(ignored.defaultPrevented).toBe(false)
    expect(host?.querySelector('[data-testid="search-panel"]')).toBeNull()

    let openEvent!: KeyboardEvent
    await act(async () => {
      openEvent = press({ key: 'f', metaKey: true, shiftKey: true })
    })
    expect(openEvent.defaultPrevented).toBe(true)
    expect(host?.querySelector('[data-testid="search-panel"]')).not.toBeNull()

    const input = host?.querySelector('[data-testid="search-panel-input"]') as HTMLInputElement
    input.blur()
    await act(async () => {
      press({ key: 'F', ctrlKey: true, shiftKey: true })
    })
    expect(document.activeElement).toBe(input)

    const composing = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    Object.defineProperty(composing, 'isComposing', { value: true })
    await act(async () => {
      window.dispatchEvent(composing)
    })
    expect(composing.defaultPrevented).toBe(false)

    await act(async () => {
      await resolve(SearchPanelService).setQuery('会议')
    })
    const selected = host?.querySelector('[aria-selected="true"]')
    expect(selected?.getAttribute('data-note-id')).toBe('meet')
    expect(selected?.querySelector('mark')?.textContent).toBe('会议')
    expect(selected?.textContent).toContain('1000000')

    await act(async () => {
      press({ key: 'Enter' })
    })
    expect(select).toHaveBeenCalledWith('meet')
    expect(host?.querySelector('[data-testid="search-panel"]')).toBeNull()
  })
})
