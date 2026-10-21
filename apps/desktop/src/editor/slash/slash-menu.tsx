import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../ui/primitives/empty-state'
import { moveSlashSelection, type SlashCommand } from './slash'

type SlashMenuProps = {
  items: SlashCommand[]
  selected: number
  command: (item: SlashCommand) => void
  clientRect?: (() => DOMRect | null) | null
}

export function SlashMenu({ items, selected, command, clientRect }: SlashMenuProps) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    let rect: DOMRect | null = null
    try {
      rect = clientRect?.() ?? null
    } catch {
      rect = null
    }
    if (!rect) return
    node.style.left = `${rect.left}px`
    node.style.top = `${rect.bottom}px`
  }, [clientRect, items, selected])

  return (
    <div ref={rootRef} data-testid="slash-menu" className="slash-menu" role="listbox">
      {items.length === 0 ? (
        <EmptyState compact title={t('editor.slash.empty')} testId="slash-menu-empty" />
      ) : (
        items.map((item, index) => {
          const isSelected = index === selected
          return (
            <div
              key={item.id}
              data-testid={`slash-${item.id}`}
              role="option"
              aria-selected={isSelected}
              className={isSelected ? 'slash-menu-item is-selected' : 'slash-menu-item'}
              onMouseDown={(event) => {
                event.preventDefault()
                command(item)
              }}
            >
              {t(`editor.slash.${item.id}`)}
            </div>
          )
        })
      )}
    </div>
  )
}

type MenuState = {
  items: SlashCommand[]
  selected: number
  command: (item: SlashCommand) => void
  clientRect?: (() => DOMRect | null) | null
}

export function renderSlashMenu() {
  let renderer: ReactRenderer | null = null
  let selected = 0
  let latest: SuggestionProps<SlashCommand, SlashCommand> | null = null

  const menuProps = (): MenuState => ({
    items: latest?.items ?? [],
    selected,
    command: (item) => {
      latest?.command(item)
    },
    clientRect: latest?.clientRect,
  })

  const paint = (props: SuggestionProps<SlashCommand, SlashCommand>) => {
    if (!latest || props.query !== latest.query) selected = 0
    if (selected >= props.items.length) selected = 0
    latest = props
    if (!renderer) {
      renderer = new ReactRenderer(SlashMenu, {
        editor: props.editor,
        props: menuProps(),
      })
      document.body.appendChild(renderer.element)
      return
    }
    renderer.updateProps(menuProps())
  }

  return {
    onStart: paint,
    onUpdate: paint,
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      if (!latest) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        selected = moveSlashSelection(selected, event.key === 'ArrowDown' ? 'down' : 'up', latest.items.length)
        renderer?.updateProps(menuProps())
        return true
      }
      if (event.key === 'Enter') {
        const item = latest.items[selected]
        if (item) latest.command(item)
        return true
      }
      if (event.key === 'Escape') return true
      return false
    },
    onExit: () => {
      renderer?.destroy()
      renderer = null
      latest = null
      selected = 0
    },
  }
}
