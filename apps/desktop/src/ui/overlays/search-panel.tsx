import { observer, useService } from '@rabjs/react'
import { Search } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { CommandService } from '../../services/commands/command.service'
import { SearchPanelService } from '../../services/search/search-panel.service'
import { VaultService } from '../../services/vault/vault.service'
import { EmptyState, Skeleton } from '../primitives/empty-state'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function markQuery(snippet: string, query: string) {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0))]
    .sort((a, b) => b.length - a.length)
  if (terms.length === 0 || snippet.length === 0) return snippet
  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'gi')
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of snippet.matchAll(pattern)) {
    const start = match.index ?? 0
    const text = match[0] ?? ''
    if (!text) continue
    if (start > cursor) nodes.push(snippet.slice(cursor, start))
    nodes.push(<mark key={start}>{text}</mark>)
    cursor = start + text.length
  }
  if (cursor < snippet.length) nodes.push(snippet.slice(cursor))
  return nodes
}

export const SearchPanel = observer(function SearchPanel() {
  const vault = useService(VaultService)
  const service = useService(SearchPanelService)
  const commands = useService(CommandService)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const results = service.open ? service.results : []
  const selectedIndex = results.length === 0 ? -1 : Math.min(service.selected, results.length - 1)
  const selectedId = selectedIndex >= 0 ? results[selectedIndex]?.id ?? '' : ''
  const titles = new Map(vault.notes.map((note) => [note.id, note.title]))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Shortcut bindings come from the command manifest; the dispatcher runs them.
      if (commands.dispatchKeydown(event)) return
      if (!service.open || event.isComposing) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        service.move(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        service.confirm()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        service.close()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [service, commands])

  useEffect(() => {
    if (!service.open) return
    inputRef.current?.focus()
  }, [service.open])

  useEffect(() => {
    if (!service.open || !selectedId) return
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [service.open, selectedId])

  if (!service.open) return null

  return (
    <div
      className="search-panel-backdrop sd-command-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) service.close()
      }}
    >
      <div
        className="search-panel sd-command-surface"
        data-testid="search-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-panel-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="search-panel-title" className="search-panel-title sd-command-title">搜索</h2>
        <div className="sd-command-search">
          <Search aria-hidden="true" size={16} strokeWidth={1.75} />
          <input
            ref={inputRef}
            className="search-panel-input sd-command-input"
            data-testid="search-panel-input"
            placeholder="搜索笔记"
            aria-label="搜索笔记"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={service.query}
            onChange={(event) => { void service.setQuery(event.target.value) }}
          />
        </div>
        {vault.searchDegraded ? <p className="sd-command-notice" data-testid="search-degraded">已降级为 BM25</p> : null}
        <div ref={listRef} className="search-panel-list sd-command-list" role="listbox" aria-label="搜索结果">
          {results.length === 0 ? (
            service.query.trim() === '' ? (
              <EmptyState
                compact
                icon={Search}
                title="输入关键词开始搜索"
                body="支持标题与全文;索引状态见底部状态栏。"
                testId="search-panel-hint"
              />
            ) : service.pending ? (
              <Skeleton rows={3} testId="search-panel-loading" />
            ) : (
              <EmptyState
                compact
                icon={Search}
                title="没有匹配的笔记"
                testId="search-panel-empty"
              />
            )
          ) : (
            <>
              <p className="search-panel-section sd-command-section">搜索结果</p>
              {results.map((hit, index) => (
                <button
                  key={hit.id}
                  type="button"
                  className="search-panel-result sd-command-item"
                  data-testid="search-result"
                  data-note-id={hit.id}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => service.choose(hit.id)}
                >
                  <span className="search-panel-result-row">
                    <span className="search-panel-note-title sd-command-item-title">{titles.get(hit.id) || hit.id}</span>
                    <span className="search-panel-score">{hit.score}</span>
                  </span>
                  {hit.snippet ? <span className="search-panel-snippet">{markQuery(hit.snippet, service.query)}</span> : null}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
})
