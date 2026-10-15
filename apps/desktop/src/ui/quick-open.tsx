import { observer, useService } from '@rabjs/react'
import { useEffect, useRef } from 'react'
import { CommandService } from '../services/command.service'
import { QuickOpenService, quickOpenResults } from '../services/quick-open.service'
import { VaultService } from '../services/vault.service'

export const QuickOpen = observer(function QuickOpen() {
  const vault = useService(VaultService)
  const service = useService(QuickOpenService)
  const commands = useService(CommandService)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const results = service.open ? quickOpenResults(vault.notes, service.query) : []
  const selectedIndex = results.length === 0 ? -1 : Math.min(service.selected, results.length - 1)
  const selectedId = selectedIndex >= 0 ? results[selectedIndex].id : ''

  useEffect(() => {
    // Capture on window so Mod+P still opens while the editor is focused, and the browser does not print.
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
      className="quick-open-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) service.close()
      }}
    >
      <div
        className="quick-open"
        data-testid="quick-open"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-open-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="quick-open-title" className="quick-open-title">快速打开</h2>
        <input
          ref={inputRef}
          className="quick-open-input"
          data-testid="quick-open-input"
          placeholder="跳到笔记"
          aria-label="跳到笔记"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={service.query}
          onChange={(event) => service.setQuery(event.target.value)}
        />
        {results.length === 0 ? (
          <p className="quick-open-empty">没有匹配的笔记</p>
        ) : (
          <div ref={listRef} className="quick-open-list" role="listbox" aria-label="笔记">
            {results.map((note, index) => (
              <button
                key={note.id}
                type="button"
                className="quick-open-result"
                data-testid="quick-open-result"
                data-note-id={note.id}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => service.choose(note.id)}
              >
                {note.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
})
