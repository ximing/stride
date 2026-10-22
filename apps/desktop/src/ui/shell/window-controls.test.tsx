import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import '../../i18n'
import { WindowControls } from './window-controls'

describe('WindowControls', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  function render() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(<WindowControls />)
    })
  }

  it('stays out of the browser shell', () => {
    render()
    expect(host?.querySelector('[data-testid="window-controls"]')).toBeNull()
  })

  it('draws close, minimize, and zoom in the desktop shell', () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    render()
    expect(host?.querySelector('[data-testid="window-close"]')).not.toBeNull()
    expect(host?.querySelector('[data-testid="window-minimize"]')).not.toBeNull()
    expect(host?.querySelector('[data-testid="window-zoom"]')).not.toBeNull()
    expect(host?.querySelector('[data-testid="window-close"]')?.getAttribute('aria-label')).toBe('Close')
  })
})
