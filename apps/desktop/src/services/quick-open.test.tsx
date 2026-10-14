import { register, resolve } from '@rabjs/react'
import { createNote, type StrideNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuickOpen } from '../ui/quick-open'
import { QUICK_OPEN_LIMIT, QuickOpenService, quickOpenResults, rankQuickOpenNotes, scoreTitle } from './quick-open.service'
import { VaultService } from './vault.service'

function note(id: string, title: string, properties: StrideNote['properties'] = {}, type = 'note'): StrideNote {
  const created = createNote(id, title, type)
  created.properties = { ...properties }
  return created
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

describe('quick open scoring', () => {
  it('ranks a substring above an ordered subsequence and ignores misses', () => {
    expect(scoreTitle('会议纪要', '纪要')).toBeGreaterThan(scoreTitle('纪检要务', '纪要'))
    expect(scoreTitle('会纪摘要', '会纪')).toBeGreaterThan(scoreTitle('会议纪要', '会纪'))
    expect(scoreTitle('Meeting', 'meet')).toBeGreaterThan(0)
    expect(scoreTitle('zzzz', '纪要')).toBe(0)

    const ranked = rankQuickOpenNotes([
      note('fuzzy', '纪检要务'),
      note('hit', '会议纪要'),
      note('miss', '购物清单'),
    ], '纪要')
    expect(ranked.map((item) => item.id)).toEqual(['hit', 'fuzzy'])

    const ordered = rankQuickOpenNotes([
      note('fuzzy', '会议纪要'),
      note('sub', '会纪摘要'),
      note('miss', '购物清单'),
    ], '会纪')
    expect(ordered.map((item) => item.id)).toEqual(['sub', 'fuzzy'])
    expect(rankQuickOpenNotes([note('hit', '会议纪要')], '没有这笔记')).toEqual([])
  })

  it('lists type documents, hides archived notes, and caps the rendered list at 50', () => {
    const notes = [
      note('live', '会议纪要'),
      note('arch', '旧纪要', { archived: true }),
      note('type', '项目', {}, 'Type'),
    ]
    const open = rankQuickOpenNotes(notes, '')
    expect(open.map((item) => item.id)).not.toContain('arch')
    expect(open.map((item) => item.id)).toEqual(expect.arrayContaining(['live', 'type']))
    expect(rankQuickOpenNotes(notes, '纪要').map((item) => item.id)).toEqual(['live'])

    const many = Array.from({ length: 60 }, (_, index) => note(`n${index}`, `T${String(index).padStart(2, '0')}`))
    expect(rankQuickOpenNotes(many, '')).toHaveLength(60)
    const shown = quickOpenResults(many, '')
    expect(shown).toHaveLength(QUICK_OPEN_LIMIT)
    expect(shown.map((item) => item.title)).not.toContain('T50')
    expect(shown[0]?.title).toBe('T00')
  })

  it('resets the selection when the query changes and does not select a miss', () => {
    register(VaultService)
    register(QuickOpenService)
    const vault = resolve(VaultService)
    const quick = resolve(QuickOpenService)
    vault.notes = [note('a', 'Alpha'), note('b', 'Beta'), note('c', '会议纪要')]
    vault.activeId = 'a'
    quick.show()
    quick.move(1)
    quick.move(1)
    quick.move(1)
    expect(quick.selected).toBe(2)
    quick.move(-1)
    quick.move(-1)
    quick.move(-1)
    expect(quick.selected).toBe(0)
    quick.move(1)
    quick.setQuery('纪要')
    expect(quick.selected).toBe(0)
    expect(quick.results.map((item) => item.id)).toEqual(['c'])
    const select = vi.spyOn(vault, 'select')
    quick.setQuery('没有')
    quick.confirm()
    expect(select).not.toHaveBeenCalled()
    expect(quick.open).toBe(true)
    quick.confirm()
    quick.setQuery('纪要')
    quick.confirm()
    expect(select).toHaveBeenCalledWith('c')
    expect(quick.open).toBe(false)
    expect(vault.activeId).toBe('c')
  })
})

describe('quick open keyboard', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    root?.unmount()
    host?.remove()
    root = null
    host = null
    vi.restoreAllMocks()
  })

  async function mount(notes: StrideNote[]) {
    register(VaultService)
    register(QuickOpenService)
    const vault = resolve(VaultService)
    const quick = resolve(QuickOpenService)
    vault.notes = notes
    vault.activeId = notes[0]?.id ?? ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<QuickOpen />)
    })
    return { vault, quick }
  }

  it('moves with arrow down, selects on enter, and closes on escape without changing the note', async () => {
    const notes = [note('alpha', 'Alpha'), note('bravo', 'Bravo'), note('gamma', 'Gamma')]
    const { vault } = await mount(notes)
    const select = vi.spyOn(vault, 'select')
    const scrolled: Element[] = []
    const previous = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      scrolled.push(this)
    }

    try {
      let openEvent!: KeyboardEvent
      await act(async () => {
        openEvent = press({ key: 'p', metaKey: true })
      })
      expect(openEvent.defaultPrevented).toBe(true)
      const dialog = host?.querySelector('[data-testid="quick-open"]')
      expect(dialog?.getAttribute('role')).toBe('dialog')
      expect(dialog?.getAttribute('aria-modal')).toBe('true')
      expect(host?.textContent).toContain('快速打开')
      expect(host?.querySelector('[data-testid="quick-open-input"]')?.getAttribute('placeholder')).toBe('跳到笔记')
      expect(host?.querySelector('[aria-selected="true"]')?.getAttribute('data-note-id')).toBe('alpha')

      const ignored = press({ key: 'f', metaKey: true })
      expect(ignored.defaultPrevented).toBe(false)
      expect(host?.querySelector('[data-testid="quick-open"]')).not.toBeNull()

      let down!: KeyboardEvent
      await act(async () => {
        down = press({ key: 'ArrowDown' })
      })
      expect(down.defaultPrevented).toBe(true)
      expect(host?.querySelector('[aria-selected="true"]')?.getAttribute('data-note-id')).toBe('bravo')
      expect(scrolled.at(-1)?.getAttribute('data-note-id')).toBe('bravo')

      await act(async () => {
        press({ key: 'ArrowUp' })
        press({ key: 'ArrowUp' })
      })
      expect(host?.querySelector('[aria-selected="true"]')?.getAttribute('data-note-id')).toBe('alpha')

      await act(async () => {
        press({ key: 'Escape' })
      })
      expect(host?.querySelector('[data-testid="quick-open"]')).toBeNull()
      expect(select).not.toHaveBeenCalled()
      expect(vault.activeId).toBe('alpha')

      await act(async () => {
        press({ key: 'p', ctrlKey: true })
      })
      const input = host?.querySelector('[data-testid="quick-open-input"]') as HTMLInputElement
      input.blur()
      await act(async () => {
        press({ key: 'p', metaKey: true })
      })
      expect(document.activeElement).toBe(input)
      expect(host?.querySelector('[data-testid="quick-open"]')).not.toBeNull()

      await act(async () => {
        press({ key: 'ArrowDown' })
      })
      await act(async () => {
        press({ key: 'Enter' })
      })
      expect(select).toHaveBeenCalledWith('bravo')
      expect(vault.activeId).toBe('bravo')
      expect(host?.querySelector('[data-testid="quick-open"]')).toBeNull()
    } finally {
      HTMLElement.prototype.scrollIntoView = previous
    }
  })

  it('hides archived notes, keeps type documents, caps the list, and ignores enter when nothing matches', async () => {
    const { vault, quick } = await mount([
      note('live', '会议纪要'),
      note('arch', '旧纪要', { archived: true }),
      note('type', '项目', {}, 'Type'),
    ])
    await act(async () => {
      press({ key: 'p', metaKey: true })
    })
    const ids = [...(host?.querySelectorAll('[data-testid="quick-open-result"]') ?? [])].map((item) => item.getAttribute('data-note-id'))
    expect(ids).not.toContain('arch')
    expect(ids).toEqual(expect.arrayContaining(['live', 'type']))

    await act(async () => {
      quick.setQuery('旧纪要')
    })
    expect(host?.textContent).toContain('没有匹配的笔记')
    const select = vi.spyOn(vault, 'select')
    await act(async () => {
      press({ key: 'Enter' })
    })
    expect(select).not.toHaveBeenCalled()
    expect(host?.querySelector('[data-testid="quick-open"]')).not.toBeNull()

    const archived = host?.querySelector('[data-note-id="arch"]')
    expect(archived).toBeNull()
    await act(async () => {
      quick.setQuery('项目')
    })
    const typeButton = host?.querySelector('[data-note-id="type"]') as HTMLButtonElement
    await act(async () => {
      typeButton.click()
    })
    expect(select).toHaveBeenCalledWith('type')
    expect(host?.querySelector('[data-testid="quick-open"]')).toBeNull()
  })

  it('renders at most 50 notes', async () => {
    const many = Array.from({ length: 60 }, (_, index) => note(`n${index}`, `T${String(index).padStart(2, '0')}`))
    await mount(many)
    await act(async () => {
      press({ key: 'p', metaKey: true })
    })
    expect(host?.querySelectorAll('[data-testid="quick-open-result"]')).toHaveLength(QUICK_OPEN_LIMIT)
    expect(host?.querySelector('[data-note-id="n50"]')).toBeNull()
  })

  it('closes when the backdrop is clicked and does not change the open note', async () => {
    const { vault } = await mount([note('alpha', 'Alpha')])
    const select = vi.spyOn(vault, 'select')
    await act(async () => {
      press({ key: 'P', ctrlKey: true })
    })
    const backdrop = host?.querySelector('.quick-open-backdrop') as HTMLElement
    await act(async () => {
      backdrop.click()
    })
    expect(select).not.toHaveBeenCalled()
    expect(vault.activeId).toBe('alpha')
    expect(host?.querySelector('[data-testid="quick-open"]')).toBeNull()
  })
})
