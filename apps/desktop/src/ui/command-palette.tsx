import { MagnifyingGlass } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { Fragment, useEffect, useRef } from 'react'
import { paletteItemSection, paletteItemTitle, type PaletteItem } from '../services/command-palette'
import { CommandPaletteService } from '../services/command-palette.service'
import { CommandService } from '../services/command.service'
import { formatShortcut } from '../services/commands'
import { EmptyState } from './empty-state'

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
  const service = useService(CommandPaletteService)
  const commands = useService(CommandService)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const items = service.open ? service.items : []
  const selectedIndex = items.length === 0 ? -1 : Math.min(service.selected, items.length - 1)
  const selectedKey = selectedIndex >= 0 ? items[selectedIndex]?.key ?? '' : ''

  // Cmd+K lives in the manifest; the handler needs this component's service closure.
  useEffect(() => commands.registerHandler('app.commandPalette', { run: () => service.toggle() }), [commands, service])

  useEffect(() => {
    // Capture on window so Mod+K works while the editor is focused.
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [commands, service])

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
      className="command-palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) service.close()
      }}
    >
      <div
        className="command-palette"
        data-testid="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="command-palette-title" className="command-palette-title">命令面板</h2>
        <input
          ref={inputRef}
          className="command-palette-input"
          data-testid="command-palette-input"
          placeholder="命令、笔记，或向 AI 提问"
          aria-label="命令、笔记，或向 AI 提问"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={service.query}
          onChange={(event) => service.setQuery(event.target.value)}
        />
        <div ref={listRef} className="command-palette-list" role="listbox" aria-label="命令与笔记">
          {items.length === 0 && (
            <EmptyState
              compact
              icon={MagnifyingGlass}
              title="没有匹配的命令或笔记"
              body="换个关键词试试;输入问题可向 AI 提问。"
              testId="command-palette-empty"
            />
          )}
          {items.map((item, index) => {
            const section = paletteItemSection(item)
            let header = null
            if (section !== lastSection) {
              lastSection = section
              header = <p className="command-palette-section">{section}</p>
            }
            const commandId = itemCommandId(item)
            const disabled = (item.kind === 'command' || item.kind === 'instance') && !item.enabled
            return (
              <Fragment key={item.key}>
                {header}
                <button
                  type="button"
                  className="command-item"
                  data-testid={itemTestId(item)}
                  data-command-id={commandId ?? undefined}
                  data-note-id={item.kind === 'note' ? item.noteId : undefined}
                  role="option"
                  aria-selected={index === selectedIndex}
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => service.activate(item)}
                >
                  <span className="command-item-title">{paletteItemTitle(item)}</span>
                  {item.kind === 'command' && item.command.shortcut ? (
                    <kbd className="command-item-shortcut">{formatShortcut(item.command.shortcut)}</kbd>
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
