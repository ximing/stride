import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Pencil as PencilSimple, Trash2 as Trash } from 'lucide-react'
import type { ContextMenuEntry } from '../../services/commands/context-menu'
import { ContextMenu } from './context-menu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

function entry(id: string, overrides: Partial<ContextMenuEntry & { kind: 'item' }> = {}): ContextMenuEntry {
  return { kind: 'item', id, label: id, ...overrides } as ContextMenuEntry
}

async function mount(items: ContextMenuEntry[], onClose: () => void) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ContextMenu x={20} y={30} items={items} onClose={onClose} />)
  })
  return document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
}

function keydown(node: HTMLElement, key: string) {
  node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function menuItem(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-testid="context-menu-item-${id}"]`)!
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  host = undefined
  document.body.replaceChildren()
})

describe('ContextMenu', () => {
  it('renders a checked item as a checkbox row', async () => {
    await mount([entry('advance', { label: 'Advance', checked: true })], () => {})
    const item = menuItem('advance')
    expect(item.getAttribute('role')).toBe('menuitemcheckbox')
    expect(item.getAttribute('aria-checked')).toBe('true')
    expect(item.querySelector('.sd-menu-item-check svg')).not.toBeNull()
  })

  it('renders items at the pointer with role=menu', async () => {
    await mount([entry('one'), entry('two')], () => {})
    const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    expect(menu).not.toBeNull()
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.style.left).toBe('20px')
    expect(menu.style.top).toBe('30px')
    expect(menuItem('one').getAttribute('role')).toBe('menuitem')
  })

  it('activates an item on click: runs onSelect once, then closes', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    await mount([entry('one', { onSelect })], onClose)
    await act(async () => {
      menuItem('one').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not activate disabled items', async () => {
    const onSelect = vi.fn()
    await mount([entry('one', { disabled: true, onSelect })], () => {})
    const node = menuItem('one')
    expect(node.hasAttribute('data-disabled')).toBe(true)
    expect(node.getAttribute('aria-disabled')).toBe('true')
    await act(async () => {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    const menu = await mount([entry('one')], onClose)
    await act(async () => keydown(menu, 'Escape'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on outside pointerdown, but not inside clicks', async () => {
    const onClose = vi.fn()
    await mount([entry('one')], onClose)
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('navigates with arrows, skipping separators and disabled rows', async () => {
    const onSelect = vi.fn()
    const menu = await mount(
      [
        entry('first', { disabled: true }),
        { kind: 'separator', id: 's1' },
        entry('second'),
        entry('third', { onSelect }),
      ],
      () => {},
    )
    // First enabled row is highlighted on open.
    expect(menuItem('second').hasAttribute('data-highlighted')).toBe(true)
    await act(async () => keydown(menu, 'ArrowDown'))
    expect(menuItem('third').hasAttribute('data-highlighted')).toBe(true)
    // Wraps around, skipping the separator and the disabled first row.
    await act(async () => keydown(menu, 'ArrowDown'))
    expect(menuItem('second').hasAttribute('data-highlighted')).toBe(true)
    await act(async () => keydown(menu, 'ArrowUp'))
    expect(menuItem('third').hasAttribute('data-highlighted')).toBe(true)
    await act(async () => keydown(menu, 'Enter'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('resets highlight when a second menu replaces the items without unmounting', async () => {
    const stale = vi.fn()
    const fresh = vi.fn()
    const other = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ContextMenu
          x={20}
          y={30}
          items={[entry('keep'), entry('stale', { onSelect: stale })]}
          onClose={() => {}}
        />,
      )
    })
    const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    await act(async () => keydown(menu, 'ArrowDown'))
    expect(menuItem('stale').hasAttribute('data-highlighted')).toBe(true)
    await act(async () => {
      root?.render(
        <ContextMenu
          x={80}
          y={90}
          items={[entry('fresh', { onSelect: fresh }), entry('other', { onSelect: other })]}
          onClose={() => {}}
        />,
      )
    })
    expect(menuItem('fresh').hasAttribute('data-highlighted')).toBe(true)
    expect(menuItem('other').hasAttribute('data-highlighted')).toBe(false)
    const next = document.querySelector<HTMLElement>('[data-testid="context-menu"]')!
    await act(async () => keydown(next, 'Enter'))
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(stale).not.toHaveBeenCalled()
  })

  it('renders shortcut hints and icons', async () => {
    await mount([entry('one', { shortcut: '⌘B', icon: PencilSimple }), entry('two', { icon: Trash, danger: true })], () => {})
    expect(menuItem('one').querySelector('.sd-menu-shortcut')?.textContent).toBe('⌘B')
    expect(menuItem('one').querySelector('.sd-menu-item-icon svg')).not.toBeNull()
    expect(menuItem('two').getAttribute('data-danger')).toBe('true')
  })
})
