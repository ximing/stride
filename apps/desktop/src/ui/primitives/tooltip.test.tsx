import { X } from 'lucide-react'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IconButton } from './button'
import { bindElementTip, Tip, TIP_OPEN_DELAY_MS } from './tooltip'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function mount(node: ReactNode): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  return { host, root }
}

function pointer(target: Element, type: 'pointermove' | 'pointerenter' | 'pointerleave') {
  // This jsdom build has no PointerEvent. The type string is what the listeners match.
  target.dispatchEvent(new MouseEvent(type, { bubbles: true }))
}

describe('Tip', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
    document.querySelectorAll('.sd-tooltip-floating').forEach((node) => node.remove())
    vi.useRealTimers()
  })

  it('opens after a short hover and does not set a native title', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ;({ host, root } = mount(
      <Tip content="Save note">
        <button type="button">Save</button>
      </Tip>,
    ))
    const button = host?.querySelector('button')
    expect(button?.getAttribute('title')).toBeNull()
    await act(async () => {
      if (button) pointer(button, 'pointermove')
    })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(TIP_OPEN_DELAY_MS - 1)
    })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Save note')
  })

  it('skips the bubble when the content is empty', () => {
    ;({ host, root } = mount(
      <Tip content="">
        <button type="button">Save</button>
      </Tip>,
    ))
    const button = host?.querySelector('button')
    expect(button?.textContent).toBe('Save')
    act(() => {
      if (button) pointer(button, 'pointermove')
    })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('shows an icon button label without a native title', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ;({ host, root } = mount(<IconButton icon={X} label="Close tab" />))
    const button = host?.querySelector('button')
    expect(button?.getAttribute('title')).toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('Close tab')
    await act(async () => {
      if (button) pointer(button, 'pointermove')
      vi.advanceTimersByTime(TIP_OPEN_DELAY_MS)
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Close tab')
  })

  it('still opens on a disabled control', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ;({ host, root } = mount(
      <Tip content="Unavailable">
        <button type="button" disabled>Wait</button>
      </Tip>,
    ))
    const shell = host?.querySelector('.sd-tip-disabled')
    expect(shell).toBeTruthy()
    await act(async () => {
      if (shell) pointer(shell, 'pointermove')
      vi.advanceTimersByTime(TIP_OPEN_DELAY_MS)
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Unavailable')
  })

  it('binds the same bubble onto a plain element', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const anchor = document.createElement('span')
    document.body.appendChild(anchor)
    const unbind = bindElementTip(anchor, () => 'Open link')
    pointer(anchor, 'pointerenter')
    expect(document.querySelector('.sd-tooltip-floating')).toBeNull()
    vi.advanceTimersByTime(TIP_OPEN_DELAY_MS)
    const tip = document.querySelector('.sd-tooltip-floating')
    expect(tip?.textContent).toBe('Open link')
    expect((tip as HTMLElement | null)?.hidden).toBe(false)
    pointer(anchor, 'pointerleave')
    expect((tip as HTMLElement | null)?.hidden).toBe(true)
    unbind()
    anchor.remove()
  })
})
