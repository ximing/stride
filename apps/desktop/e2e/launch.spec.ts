import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'

const scratch = process.env.STRIDE_SCRATCH || path.join(os.tmpdir(), 'stride-launch')

async function launchOnce(name: string, page: import('@playwright/test').Page) {
  const errors: string[] = []
  const consoleLog: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleLog.push(message.text())
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-ui-'))
  const out = path.join(scratch, name)
  fs.mkdirSync(out, { recursive: true })
  await page.goto('/')
  const surface = page.getByTestId('vault-surface')
  await expect(surface).toBeVisible()
  const box = await surface.boundingBox()
  const viewport = page.viewportSize()
  expect(box).toBeTruthy()
  expect(viewport).toBeTruthy()
  expect(box!.width * box!.height).toBeGreaterThan(viewport!.width * viewport!.height * 0.6)
  await page.getByTestId('vault-path').fill(dir)
  await page.getByTestId('open-vault').click()
  await page.getByTestId('new-note').click()
  await expect(page.getByTestId('editor').locator('.ProseMirror')).toBeVisible()
  await page.getByTestId('new-note').click()
  await expect(page.getByRole('button', { name: 'Untitled' })).toHaveCount(2)
  await expect(page.getByTestId('editor').locator('.ProseMirror')).toBeVisible()
  await page.screenshot({ path: path.join(out, 'screen.png'), fullPage: true })
  fs.writeFileSync(path.join(out, 'console.log'), [...consoleLog, ...errors.map((error) => `pageerror: ${error}`)].join('\n'))
  expect(errors, errors.join('\n')).toEqual([])
}

test('launch 1', async ({ page }) => {
  await launchOnce('launch-1', page)
})

test('launch 2', async ({ page }) => {
  await launchOnce('launch-2', page)
})
