#!/usr/bin/env node
// Measure NoteList performance against a 10k-note in-memory fixture vault.
//
// Usage:
//   node scripts/perf-note-list.mjs [--count 10000] [--port 1430]
//
// Starts an isolated vite dev server, drives real Chromium via Playwright, and
// reports: first render time, rendered DOM rows (virtualization proof), scroll
// FPS (min/avg over a 3s driven scroll), and inline-filter keystroke latency.
// Requires Playwright's chromium (`pnpm exec playwright install chromium`).

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { count: 10_000, port: 1430 }
  const rest = [...argv]
  while (rest.length > 0) {
    const token = rest.shift()
    if (token === '--count') args.count = Number(rest.shift())
    else if (token === '--port') args.port = Number(rest.shift())
  }
  return args
}

const { count, port } = parseArgs(process.argv.slice(2))
const base = `http://127.0.0.1:${port}`

const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
})

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('vite dev server did not come up')
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', (message) => {
    if (message.text().startsWith('[fixture]')) console.log(`  ${message.text()}`)
  })
  await page.goto(`${base}/?fixture=memory&seed=${count}`)
  await page.waitForSelector('[data-testid="open-vault"]')

  // First render: click Open vault -> notes counted in the list header.
  const t0 = Date.now()
  await page.click('[data-testid="open-vault"]')
  await page.waitForSelector('[data-testid="note-list-item"]', { timeout: 120_000 })
  const firstRowMs = Date.now() - t0
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="note-list-count"]')?.textContent === String(expected),
    count,
    { timeout: 120_000 },
  )
  const fullMs = Date.now() - t0

  const domRows = await page.locator('.note-list-item').count()

  // Wait for the background search-index rebuild to finish so scroll/filter
  // numbers reflect steady-state list rendering, not indexing contention.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="index-status"]')?.textContent?.includes('索引就绪'),
    { timeout: 300_000 },
  )
  const indexReadyMs = Date.now() - t0

  // Scroll FPS: drive scrollTop inside a rAF loop for 3s, sampling frame deltas.
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector('.note-list-items')
    if (!el) return null
    const deltas = []
    let last = performance.now()
    const until = last + 3000
    await new Promise((resolve) => {
      const step = (now) => {
        deltas.push(now - last)
        last = now
        el.scrollTop = (el.scrollTop + 997) % (el.scrollHeight - el.clientHeight || 1)
        if (now < until) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
    return deltas.slice(1)
  })
  const fps = (deltas) => deltas.map((d) => 1000 / d)
  const scrollFps = scroll ? fps(scroll) : []
  const avgFps = scrollFps.length ? scrollFps.reduce((a, b) => a + b, 0) / scrollFps.length : 0
  const minFps = scrollFps.length ? Math.min(...scrollFps) : 0

  // Filter latency: type a query, measure input event -> list re-rendered.
  const filterMs = await page.evaluate(async () => {
    const input = document.querySelector('[data-testid="list-filter"]')
    if (!input) return -1
    const before = document.querySelectorAll('.note-list-item').length
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const started = performance.now()
    setter.call(input, 'garden')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const elapsed = performance.now() - started
    const after = document.querySelectorAll('.note-list-item').length
    return { elapsed, changed: before !== after || document.querySelectorAll('.note-list-item-title').length >= 0 }
  })

  // Restore: clear the filter so the vault is usable after the run.
  await page.click('[data-testid="list-filter-clear"]').catch(() => undefined)

  console.log('')
  console.log('NoteList performance — fixture=memory seed=' + count)
  console.log('----------------------------------------------')
  console.log(`notes in vault:        ${count}`)
  console.log(`DOM rows rendered:     ${domRows}`)
  console.log(`first row rendered:    ${firstRowMs} ms (click "Open vault" -> first row)`)
  console.log(`full list counted:     ${fullMs} ms (includes fixture generation + parse)`)
  console.log(`search index ready:    ${indexReadyMs} ms (background; scroll/filter measured after this)`)
  if (scroll) {
    console.log(`scroll FPS (3s):       avg ${avgFps.toFixed(1)}  min ${minFps.toFixed(1)}  p5 ${percentile(scrollFps, 5).toFixed(1)}`)
  }
  if (typeof filterMs === 'object') {
    console.log(`filter keystroke:      ${filterMs.elapsed.toFixed(1)} ms (input event -> re-rendered rows)`)
  }
  console.log('')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
