import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Agent-facing contract, same shape as CSI:
//   POST /command  {"action","args","session"}  ->  { success, data } | { success:false, error, code? }
// The Tauri webview connects out (POST /bridge/poll) the way the CSI extension connects to its daemon.
// Bind is 127.0.0.1 only. Port: STRIDE_INSPECT_PORT or 14388.

const TOOLS = ['snapshot', 'click', 'fill', 'evaluate', 'wait', 'screenshot', 'status'] as const
const DEFAULT_PORT = 14388

interface PendingCommand {
  id: string
  action: string
  args: Record<string, unknown>
  resolve: (body: Envelope) => void
  timer: ReturnType<typeof setTimeout>
}

interface Envelope {
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

interface Poller {
  resolve: (command: { id: string; action: string; args: Record<string, unknown> } | null) => void
}

export interface InspectServer {
  url: string
  port: number
  close: () => Promise<void>
}

export async function startInspectServer(options: { port?: number; toolTimeoutMs?: number } = {}): Promise<InspectServer> {
  const toolTimeoutMs = options.toolTimeoutMs ?? 30_000
  let lastSeen = 0
  let poller: Poller | null = null
  let inflight: PendingCommand | null = null
  const queue: PendingCommand[] = []

  const deliver = () => {
    if (!poller || inflight || queue.length === 0) return
    const next = queue.shift()!
    const waiting = poller
    poller = null
    inflight = next
    waiting.resolve({ id: next.id, action: next.action, args: next.args })
  }

  const fail = (command: PendingCommand, body: Envelope) => {
    clearTimeout(command.timer)
    command.resolve(body)
  }

  const finish = (id: string, body: Envelope) => {
    const queued = queue.findIndex((item) => item.id === id)
    if (queued >= 0) {
      const [command] = queue.splice(queued, 1)
      fail(command, body)
      return
    }
    if (!inflight || inflight.id !== id) return
    const current = inflight
    inflight = null
    fail(current, body)
    deliver()
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') {
      send(res, 204, {})
      return
    }
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
        res.end('ok')
        return
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        send(res, 200, statusBody(server, lastSeen, poller != null || inflight != null))
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/poll') {
        await readBody(req)
        lastSeen = Date.now()
        const queued = queue[0]
        if (queued && !inflight) {
          queue.shift()
          inflight = queued
          send(res, 200, { id: queued.id, action: queued.action, args: queued.args })
          return
        }
        const command = await new Promise<{ id: string; action: string; args: Record<string, unknown> } | null>((resolve) => {
          poller = { resolve }
          res.on('close', () => {
            if (poller?.resolve === resolve) poller = null
          })
        })
        if (!command) {
          send(res, 200, { idle: true })
          return
        }
        send(res, 200, command)
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/result') {
        const body = JSON.parse((await readBody(req)) || '{}') as Envelope & { id?: string }
        lastSeen = Date.now()
        if (!body.id) {
          send(res, 200, { success: false, error: 'bridge result id is required' })
          return
        }
        finish(body.id, body.success
          ? { success: true, data: body.data }
          : { success: false, error: body.error || 'webview command failed' })
        send(res, 200, { success: true })
        return
      }
      if (req.method === 'POST' && url.pathname === '/command') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          action?: string
          args?: Record<string, unknown>
          session?: string
        }
        const action = body.action || ''
        const args = body.args || {}
        if (!action) {
          send(res, 200, { success: false, error: 'action is required' })
          return
        }
        if (!TOOLS.includes(action as typeof TOOLS[number])) {
          send(res, 200, { success: false, error: `unknown tool: ${action}` })
          return
        }
        if (action === 'status') {
          send(res, 200, { success: true, data: statusBody(server, lastSeen, poller != null || inflight != null) })
          return
        }
        if (action === 'screenshot') {
          send(res, 200, await captureWindow(args))
          return
        }
        if (!poller && Date.now() - lastSeen > 3000) {
          send(res, 200, {
            success: false,
            error: 'webview not connected',
            code: 'webview_offline',
          })
          return
        }
        const result = await new Promise<Envelope>((resolve) => {
          const command: PendingCommand = {
            id: `${Date.now().toString(36)}-${queue.length}`,
            action,
            args,
            resolve,
            timer: setTimeout(() => {
              finish(command.id, { success: false, error: `tool call timeout (${toolTimeoutMs}ms)` })
            }, toolTimeoutMs),
          }
          queue.push(command)
          if (poller) {
            const waiting = poller
            poller = null
            const next = queue.shift()!
            inflight = next
            waiting.resolve({ id: next.id, action: next.action, args: next.args })
          }
        })
        send(res, 200, result)
        return
      }
      send(res, 404, { success: false, error: 'not found' })
    } catch (error) {
      send(res, 200, { success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('inspect server has no port')

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve) => {
      if (poller) {
        const waiting = poller
        poller = null
        waiting.resolve(null)
      }
      for (const command of [inflight, ...queue]) {
        if (!command) continue
        clearTimeout(command.timer)
        command.resolve({ success: false, error: 'inspect server closed' })
      }
      queue.length = 0
      inflight = null
      server.close(() => resolve())
    }),
  }
}

function statusBody(server: http.Server, lastSeen: number, active: boolean) {
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : DEFAULT_PORT
  return {
    running: true,
    webview_connected: active || Date.now() - lastSeen < 3000,
    port,
    bind_host: '127.0.0.1',
    tools: TOOLS,
    last_seen_ms: lastSeen ? Date.now() - lastSeen : null,
  }
}

async function captureWindow(args: Record<string, unknown>): Promise<Envelope> {
  const id = await strideWindowId()
  if (!id) {
    return { success: false, error: 'Stride window not found', code: 'window_not_found' }
  }
  const dest = typeof args.path === 'string' && args.path
    ? args.path
    : path.join(os.tmpdir(), 'stride-inspect', `screen-${Date.now()}.png`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    await exec('screencapture', ['-x', '-l', String(id), dest], { timeout: 10000 })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    return { success: false, error: 'screenshot file was not written' }
  }
  return { success: true, data: { path: dest, windowId: id } }
}

async function strideWindowId(): Promise<number | null> {
  const source = `
import CoreGraphics
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for item in info {
  let owner = item[kCGWindowOwnerName as String] as? String ?? ""
  let name = item[kCGWindowName as String] as? String ?? ""
  let layer = item[kCGWindowLayer as String] as? Int ?? 0
  if layer == 0 && (owner == "stride-desktop" || name == "Stride") {
    if let id = item[kCGWindowNumber as String] as? Int, id > 0 {
      print(id)
      exit(0)
    }
  }
}
`
  try {
    const { stdout } = await exec('swift', ['-e', source], { timeout: 20000 })
    const id = Number(stdout.trim().split('\n').filter(Boolean).pop())
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(raw)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entry && fileURLToPath(import.meta.url) === entry) {
  const port = Number(process.env.STRIDE_INSPECT_PORT || DEFAULT_PORT)
  const server = await startInspectServer({ port })
  process.stdout.write(`stride inspect http://127.0.0.1:${server.port}\n`)
  process.stdout.write('POST /command {"action":"snapshot","args":{},"session":"stride"}\n')
}
