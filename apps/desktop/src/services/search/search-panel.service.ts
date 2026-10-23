import { Service } from '@rabjs/react'
import { type RankedHit } from '@stride/core'
import { closeOtherOverlays } from '../platform/overlays'
import { TabsService } from '../notes/tabs.service'
import { VaultService } from '../vault/vault.service'

export function isSearchPanelShortcut(event: KeyboardEvent): boolean {
  if (!event.shiftKey || event.altKey) return false
  if (!event.metaKey && !event.ctrlKey) return false
  return event.key === 'f' || event.key === 'F'
}

export class SearchPanelService extends Service {
  open = false
  query = ''
  selected = 0
  results: RankedHit[] = []
  // True while a ranked query is in flight; drives the panel skeleton.
  pending = false

  private ticket = 0

  private get vault() {
    return this.resolve(VaultService)
  }

  private get tabs() {
    return this.resolve(TabsService)
  }

  show() {
    if (this.open) return
    closeOtherOverlays('searchPanel', () => this.close())
    this.ticket += 1
    this.query = ''
    this.selected = 0
    this.results = []
    this.open = true
  }

  close() {
    this.ticket += 1
    this.open = false
    this.query = ''
    this.selected = 0
    this.results = []
  }

  setQuery(value: string) {
    if (value === this.query) return Promise.resolve()
    this.query = value
    this.selected = 0
    this.results = []
    return this.refresh()
  }

  move(delta: number) {
    const total = this.results.length
    if (total === 0) return
    const current = Math.min(Math.max(this.selected, 0), total - 1)
    const next = current + delta
    if (next < 0 || next >= total) return
    this.selected = next
  }

  confirm() {
    const items = this.results
    if (items.length === 0) return
    const hit = items[Math.min(Math.max(this.selected, 0), items.length - 1)]
    if (!hit) return
    this.chooseHit(hit)
  }

  choose(id: string) {
    const hit = this.results.find((item) => item.id === id)
    if (!hit) return
    this.chooseHit(hit)
  }

  private chooseHit(hit: RankedHit) {
    const title = this.vault.notes.find((note) => note.id === hit.id)?.title ?? ''
    this.tabs.openNote(hit.id)
    this.close()
    if (hit.source === 'title') {
      const start = hit.offset
      const end = hit.offset + hit.length
      setTimeout(() => focusTitle(start, end), 0)
      return
    }
    const offset = hit.offset - title.length - 1
    const length = hit.length
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('stride-search-jump', { detail: { offset, length } }))
    }, 0)
  }

  private async refresh() {
    const query = this.query
    const ticket = ++this.ticket
    if (!query.trim()) {
      this.results = []
      this.pending = false
      return
    }
    this.pending = true
    try {
      const hits = await this.vault.queryRanked(query)
      if (ticket !== this.ticket) return
      this.results = hits
      if (this.selected >= hits.length) this.selected = 0
    } catch {
      if (ticket !== this.ticket) return
      this.results = []
    } finally {
      if (ticket === this.ticket) this.pending = false
    }
  }
}

function focusTitle(start: number, end: number) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="note-title"]')
  if (!input) return
  input.focus()
  input.setSelectionRange(start, end)
}
