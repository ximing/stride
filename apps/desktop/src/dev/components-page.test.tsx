import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ComponentsPage } from './components-page'

describe('components preview', () => {
  let root: ReturnType<typeof createRoot> | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
  })

  it('renders the shell regions and switches the theme on the wrapper', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<ComponentsPage />)
    })

    expect(host.querySelector('[data-testid="region-sidebar"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="region-notes"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="region-editor"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="region-inspector"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="region-statusbar"]')).not.toBeNull()

    const preview = host.querySelector('[data-testid="design-preview"]')
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="theme-dark"]')?.click()
    })
    expect(preview?.getAttribute('data-theme')).toBe('dark')

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('[data-testid="theme-light"]')?.click()
    })
    expect(preview?.getAttribute('data-theme')).toBe('light')
  })
})
