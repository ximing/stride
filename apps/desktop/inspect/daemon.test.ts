// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { startInspectServer, type InspectServer } from './daemon.ts'

const servers: InspectServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json() as Promise<{ success: boolean; data?: unknown; error?: string; code?: string; id?: string; action?: string; args?: Record<string, unknown>; idle?: boolean }>
}

describe('stride inspect daemon', () => {
  it('rejects a command until the webview connects, then runs it on that page', async () => {
    const server = await startInspectServer({ port: 0, toolTimeoutMs: 2000 })
    servers.push(server)
    const health = await fetch(`${server.url}/healthz`)
    expect(await health.text()).toBe('ok')

    const offline = await post(`${server.url}/command`, { action: 'snapshot', session: 'stride' })
    expect(offline.success).toBe(false)
    expect(offline.code).toBe('webview_offline')

    const unknown = await post(`${server.url}/command`, { action: 'navigate' })
    expect(unknown.error).toMatch(/unknown tool/)

    const poll = post(`${server.url}/bridge/poll`, {})
    await new Promise((resolve) => setTimeout(resolve, 30))
    const status = await fetch(`${server.url}/status`).then((response) => response.json() as Promise<{ webview_connected: boolean }>)
    expect(status.webview_connected).toBe(true)

    const command = post(`${server.url}/command`, {
      action: 'evaluate',
      args: { code: 'return 1' },
      session: 'stride',
    })
    const delivered = await poll
    expect(delivered.action).toBe('evaluate')
    expect(delivered.args).toEqual({ code: 'return 1' })
    await post(`${server.url}/bridge/result`, { id: delivered.id, success: true, data: { value: 1 } })
    await expect(command).resolves.toEqual({ success: true, data: { value: 1 } })
  })

  it('returns the page error instead of hanging when the webview command fails', async () => {
    const server = await startInspectServer({ port: 0, toolTimeoutMs: 2000 })
    servers.push(server)
    const poll = post(`${server.url}/bridge/poll`, {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    const command = post(`${server.url}/command`, { action: 'click', args: { selector: '@e4' } })
    const delivered = await poll
    await post(`${server.url}/bridge/result`, {
      id: delivered.id,
      success: false,
      error: 'click: unknown ref "@e4". Run snapshot first.',
    })
    const result = await command
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unknown ref/)
  })

  it('keeps the webview online across the gap between a result and the next poll', async () => {
    const server = await startInspectServer({ port: 0, toolTimeoutMs: 2000 })
    servers.push(server)
    const firstPoll = post(`${server.url}/bridge/poll`, {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    const first = post(`${server.url}/command`, { action: 'evaluate', args: { code: 'return 1' } })
    const delivered = await firstPoll
    await post(`${server.url}/bridge/result`, { id: delivered.id, success: true, data: { value: 1 } })
    await first
    const second = post(`${server.url}/command`, { action: 'snapshot', session: 'stride' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const nextPoll = await post(`${server.url}/bridge/poll`, {})
    expect(nextPoll.action).toBe('snapshot')
    await post(`${server.url}/bridge/result`, { id: nextPoll.id, success: true, data: { tree: '' } })
    await expect(second).resolves.toMatchObject({ success: true })
  })

  it('times out a command left queued after the webview drops', async () => {
    const server = await startInspectServer({ port: 0, toolTimeoutMs: 150 })
    servers.push(server)
    const controller = new AbortController()
    const poll = fetch(`${server.url}/bridge/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await poll
    const result = await post(`${server.url}/command`, { action: 'snapshot', session: 'stride' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timeout/)
  })
})
