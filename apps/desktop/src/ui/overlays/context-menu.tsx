// Unified context-menu popup for every surface (note list, editor, folder
// tree). AD-3: @radix-ui/react-context-menu is not a dependency, so this is a
// self-managed fixed popup that reuses the .sd-menu visual language of the
// Radix-backed dropdown (ui/menu.tsx) — same classes, same tokens.
//
// Behavior contract (pinned by ui/context-menu.test.tsx):
// - Positions at the pointer, clamped into the viewport after first measure.
// - Closes on Escape, Tab, outside pointerdown, outside contextmenu, scroll,
//   resize, and window blur.
// - Keyboard: ArrowUp/Down cycle enabled items (separators and disabled rows
//   are skipped), Home/End jump, Enter activates. The focused popup keeps the
//   host surface's own key handlers (e.g. the note list's Esc-clears-selection)
//   from firing while it is open.
// - Activating an item runs onSelect exactly once, then closes.

import { Check } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextMenuEntry } from '../../services/commands/context-menu'
import { useLayer } from '../primitives/layer'

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuEntry[]
  onClose: () => void
  testId?: string
}

function firstEnabled(items: ContextMenuEntry[]): number {
  return items.findIndex((entry) => entry.kind === 'item' && !entry.disabled)
}

function stepEnabled(items: ContextMenuEntry[], from: number, delta: 1 | -1): number {
  if (items.length === 0) return -1
  let index = from
  for (let count = 0; count < items.length; count += 1) {
    index = (index + delta + items.length) % items.length
    const entry = items[index]!
    if (entry.kind === 'item' && !entry.disabled) return index
  }
  return -1
}

export function ContextMenu({ x, y, items, onClose, testId = 'context-menu' }: ContextMenuProps) {
  const layer = useLayer()
  const rootRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const [highlight, setHighlight] = useState(() => firstEnabled(items))

  // Clamp into the viewport once the popup has been measured.
  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const margin = 4
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))
    const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    if (left !== x || top !== y) setPosition({ left, top })
  }, [x, y])

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      onClose()
    }
    // A right-click anywhere outside dismisses this menu; the surface under
    // the pointer opens its own in the same event (capture runs first).
    const onContextMenu = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const onScroll = (event: Event) => {
      if (rootRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const onBlur = () => onClose()
    const onResize = () => onClose()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose])

  function activate(index: number) {
    const entry = items[index]
    if (!entry || entry.kind !== 'item' || entry.disabled) return
    onClose()
    entry.onSelect?.()
  }

  function onKeyDown(event: React.KeyboardEvent) {
    let next = -1
    if (event.key === 'ArrowDown') next = stepEnabled(items, highlight, 1)
    else if (event.key === 'ArrowUp') next = stepEnabled(items, highlight, -1)
    else if (event.key === 'Home') next = firstEnabled(items)
    else if (event.key === 'End') next = stepEnabled(items, items.length, -1)
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      activate(highlight)
      return
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (next !== -1) setHighlight(next)
  }

  const menu = (
    // The container owns focus and key handling; items are plain divs.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={rootRef}
      className="sd-menu sd-context-menu"
      data-testid={testId}
      role="menu"
      tabIndex={-1}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((entry, index) => {
        if (entry.kind === 'separator') {
          return <div key={entry.id} className="sd-menu-separator" role="separator" />
        }
        const Glyph = entry.icon
        const checkable = entry.checked !== undefined
        return (
          <div
            key={entry.id}
            className="sd-menu-item"
            data-testid={`${testId}-item-${entry.id}`}
            role={checkable ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={checkable ? entry.checked : undefined}
            aria-disabled={entry.disabled || undefined}
            tabIndex={-1}
            {...(entry.disabled ? { 'data-disabled': '' } : {})}
            {...(entry.danger ? { 'data-danger': 'true' } : {})}
            {...(index === highlight && !entry.disabled ? { 'data-highlighted': '' } : {})}
            onMouseEnter={() => {
              if (!entry.disabled) setHighlight(index)
            }}
            onClick={(event) => {
              event.stopPropagation()
              activate(index)
            }}
          >
            {checkable && (
              <span className="sd-menu-item-icon sd-menu-item-check">
                {entry.checked ? <Check aria-hidden="true" size={14} strokeWidth={1.75} /> : null}
              </span>
            )}
            {Glyph && (
              <span className="sd-menu-item-icon">
                <Glyph aria-hidden="true" size={14} strokeWidth={1.75} />
              </span>
            )}
            <span className="sd-menu-item-label">{entry.label}</span>
            {entry.shortcut && <kbd className="sd-menu-shortcut">{entry.shortcut}</kbd>}
          </div>
        )
      })}
    </div>
  )
  return createPortal(menu, layer ?? document.body)
}
