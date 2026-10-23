import { observer, useService } from '@rabjs/react'
import { Search } from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { paletteItemSection, paletteItemTitle, type PaletteItem } from '../../services/commands/command-palette'
import { CommandPaletteService } from '../../services/commands/command-palette.service'
import { CommandService } from '../../services/commands/command.service'
import { formatShortcut } from '../../services/commands/commands'
import { handleOverlayListKey, registerOverlayKeys } from '../../services/platform/overlay-keys'
import { EmptyState } from '../primitives/empty-state'

function itemTestId(item: PaletteItem): string {
  if (item.kind === 'command' || item.kind === 'instance') return 'command-item'
  if (item.kind === 'note') return 'command-palette-note'
  return 'command-palette-ai'
}

function itemCommandId(item: PaletteItem): string | null {
  if (item.kind === 'command') return item.command.id
  if (item.kind === 'instance') return `file.newInstance:${item.typeTitle}`
  return null
}

export const CommandPalette = observer(function CommandPalette() {
  const { t } = useTranslation()
  const service = useService(CommandPaletteService)
  const commands = useService(CommandService)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const items = service.open ? service.items : []
  const selectedIndex = items.length === 0 ? -1 : Math.min(service.selected, items.length - 1)
  const selectedKey = selectedIndex >= 0 ? items[selectedIndex]?.key ?? '' : ''

  // Cmd+K lives in the manifest; the handler needs this component's service closure.
  useEffect(() => commands.registerHandler('app.commandPalette', { run: () => service.toggle() }), [commands, service])

  useEffect(
    () =>
      registerOverlayKeys({
        id: 'commandPalette',
        layer: 'panel',
        isOpen: () => service.open,
        onKeyDown: (event) => {
          if (!service.open) return
          handleOverlayListKey(event, {
            move: (delta) => service.move(delta),
            confirm: () => service.confirm(),
            close: () => service.close(),
          })
        },
      }),
    [service],
  )

  useEffect(() => {
    if (!service.open) return
    inputRef.current?.focus()
  }, [service.open])

  useEffect(() => {
    if (!service.open || !selectedKey) return
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [service.open, selectedKey])

  if (!service.open) return null

  let lastSection = ''

  return (
    <div
      className="command-palette-backdrop sd-command-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) service.close()
      }}
    >
      <div
        className="command-palette sd-command-surface"
        data-testid="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="command-palette-title" className="command-palette-title sd-command-title">{t('palette.title')}</h2>
        <div className="sd-command-search">
          <Search aria-hidden="true" size={16} strokeWidth={1.75} />
          <input
            ref={inputRef}
            className="command-palette-input sd-command-input"
            data-testid="command-palette-input"
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={service.query}
            onChange={(event) => service.setQuery(event.target.value)}
          />
        </div>
        <div ref={listRef} className="command-palette-list sd-command-list" role="listbox" aria-label={t('palette.list')}>
          {items.length === 0 && (
            <EmptyState
              compact
              icon={Search}
              title={t('palette.emptyTitle')}
              body={t('palette.emptyBody')}
              testId="command-palette-empty"
            />
          )}
          {items.map((item, index) => {
            const section = paletteItemSection(item)
            let header = null
            if (section !== lastSection) {
              lastSection = section
              header = <p className="command-palette-section sd-command-section">{section}</p>
            }
            const commandId = itemCommandId(item)
            const disabled = (item.kind === 'command' || item.kind === 'instance') && !item.enabled
            return (
              <Fragment key={item.key}>
                {header}
                <button
                  type="button"
                  className="command-item sd-command-item"
                  data-testid={itemTestId(item)}
                  data-command-id={commandId ?? undefined}
                  data-note-id={item.kind === 'note' ? item.noteId : undefined}
                  role="option"
                  aria-selected={index === selectedIndex}
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => service.activate(item)}
                >
                  <span className="sd-command-item-title">{paletteItemTitle(item)}</span>
                  {item.kind === 'command' && item.command.shortcut ? (
                    <kbd className="command-item-shortcut sd-command-kbd">{formatShortcut(item.command.shortcut)}</kbd>
                  ) : null}
                </button>
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
})
