import { useLayoutEffect, useRef, type KeyboardEvent, type FocusEvent, type MouseEvent } from 'react'

/** One tab stop for the tree; arrow navigation never changes the list scope. */
export function useTreeNavigation(actions: {
  toggle(path: string): void
  rename(path: string): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const remembered = useRef<HTMLElement | null>(null)
  const lastFocused = useRef<HTMLElement | null>(null)
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
  const remember = (item: HTMLElement) => {
    for (const node of items()) node.tabIndex = node === item ? 0 : -1
    remembered.current = item
  }
  const focus = (item?: HTMLElement) => {
    if (!item) return
    remember(item)
    item.focus({ preventScroll: true })
    const line = item.querySelector<HTMLElement>(':scope > .folder-row-main') ?? item
    line.scrollIntoView?.({ block: 'nearest' })
  }
  useLayoutEffect(() => {
    const rows = items()
    const previous = remembered.current
    if (previous && rows.includes(previous)) {
      remember(previous)
      if (lastFocused.current && !lastFocused.current.isConnected && document.activeElement === document.body) previous.focus({ preventScroll: true })
      return
    }
    // A collapsed ancestor or renamed row replaces the focused item. Keep a
    // nearby tab stop, but never take focus away from an editor or toolbar.
    const key = previous?.dataset.treeKey
    const parent = previous?.dataset.treeParent
    const next = rows.find(row => row.dataset.treeKey === key)
      ?? rows.find(row => row.dataset.path === parent)
      ?? rows[0]
    if (next) {
      remember(next)
      if (previous && document.activeElement === document.body) next.focus({ preventScroll: true })
    }
  })
  return {
    ref,
    onFocusCapture(event: FocusEvent<HTMLDivElement>) {
      lastFocused.current = event.target as HTMLElement
      const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
      if (row) remember(row)
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      const target = event.target as HTMLElement
      if (target.closest('input, [contenteditable="true"], .folder-row-actions')) return
      const row = target.closest<HTMLElement>('[role="treeitem"]')
      if (row) focus(row)
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return
      if (event.shiftKey && event.key !== 'F10') return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"], .folder-row-actions')) return
      const row = target.closest<HTMLElement>('[role="treeitem"]')
      if (!row) return
      const rows = items()
      const index = rows.indexOf(row)
      const path = row.dataset.path
      switch (event.key) {
        case 'ContextMenu':
        case 'F10': {
          if (event.key === 'F10' && !event.shiftKey) return
          const box = row.getBoundingClientRect()
          row.dispatchEvent(new globalThis.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left, clientY: box.top }))
          break
        }
        case 'ArrowDown': focus(rows[index + 1]); break
        case 'ArrowUp': focus(rows[index - 1]); break
        case 'Home': focus(rows[0]); break
        case 'End': focus(rows.at(-1)); break
        case 'ArrowRight':
          if (path) {
            if (row.getAttribute('aria-expanded') === 'false') actions.toggle(path)
            else focus(row.querySelector<HTMLElement>('[role="treeitem"]') ?? undefined)
          }
          break
        case 'ArrowLeft':
          if (path && row.getAttribute('aria-expanded') === 'true') actions.toggle(path)
          else focus(rows.find(item => item.dataset.path === row.dataset.treeParent))
          break
        case 'Enter':
        case ' ':
          if (path) row.querySelector<HTMLButtonElement>('[data-testid="folder-label"]')?.click()
          else row.click()
          break
        case 'F2':
          if (!path) return
          actions.rename(path)
          break
        default: return
      }
      event.preventDefault()
      event.stopPropagation()
    },
  }
}
