import { observer, useService } from '@rabjs/react'
import { FileText, Search } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CommandService } from '../../services/commands/command.service'
import { QuickOpenService, quickOpenResults } from '../../services/search/quick-open.service'
import { VaultService } from '../../services/vault/vault.service'
import { EmptyState } from '../primitives/empty-state'

export const QuickOpen = observer(function QuickOpen() {
  const { t } = useTranslation()
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
      className="quick-open-backdrop sd-command-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) service.close()
      }}
    >
      <div
        className="quick-open sd-command-surface"
        data-testid="quick-open"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-open-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="quick-open-title" className="quick-open-title sd-command-title">{t('quickOpen.title')}</h2>
        <div className="sd-command-search">
          <Search aria-hidden="true" size={16} strokeWidth={1.75} />
          <input
            ref={inputRef}
            className="quick-open-input sd-command-input"
            data-testid="quick-open-input"
            placeholder={t('quickOpen.placeholder')}
            aria-label={t('quickOpen.placeholder')}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={service.query}
            onChange={(event) => service.setQuery(event.target.value)}
          />
        </div>
        <div ref={listRef} className="quick-open-list sd-command-list" role="listbox" aria-label={t('quickOpen.list')}>
          {results.length === 0 ? (
            service.query.trim() === '' ? (
              <EmptyState
                compact
                icon={FileText}
                title={t('quickOpen.emptyTitle')}
                body={t('quickOpen.emptyBody')}
                testId="quick-open-empty"
              />
            ) : (
              <EmptyState
                compact
                icon={Search}
                title={t('quickOpen.noMatch')}
                testId="quick-open-empty"
              />
            )
          ) : (
            <>
              <p className="sd-command-section">{t('quickOpen.notes')}</p>
              {results.map((note, index) => (
                <button
                  key={note.id}
                  type="button"
                  className="quick-open-result sd-command-item"
                  data-testid="quick-open-result"
                  data-note-id={note.id}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => service.choose(note.id)}
                >
                  <span className="sd-command-item-title">{note.title}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
})
