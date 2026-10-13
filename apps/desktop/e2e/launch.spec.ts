import { expect, test } from '@playwright/test'
import { startInspectServer, type InspectServer } from '../inspect/daemon.ts'

// The dev page polls this port unless VITE_STRIDE_INSPECT_PORT is set.
const INSPECT_PORT = 14388

test('opens a memory vault and creates a note without console errors', async ({ page }) => {
  const server: InspectServer = await startInspectServer({ port: INSPECT_PORT })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  try {
    await page.goto('/?fixture=memory')

    await expect.poll(async () => {
      const status = await fetch(`${server.url}/status`).then((response) => response.json() as Promise<{ webview_connected: boolean }>)
      return status.webview_connected
    }, { timeout: 15_000 }).toBe(true)

    const evaluated = await fetch(`${server.url}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'evaluate',
        args: { code: 'return location.search' },
        session: 'stride',
      }),
    }).then((response) => response.json() as Promise<{ success: boolean; data?: { value?: unknown } }>)
    expect(evaluated).toEqual({ success: true, data: { value: '?fixture=memory' } })

    await page.getByTestId('open-vault').click()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('editor').locator('.ProseMirror')).toBeVisible()
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  } finally {
    // The page long-polls /bridge/poll. Closing the server first waits forever
    // on that keep-alive socket, so drop the page before the daemon.
    await page.close().catch(() => undefined)
    await server.close()
  }
})
