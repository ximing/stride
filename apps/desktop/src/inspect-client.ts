import { runPageCommand } from './inspect-page'

const DEFAULT_PORT = 14388

export function startInspectClient(port = Number(import.meta.env.VITE_STRIDE_INSPECT_PORT || DEFAULT_PORT)) {
  rememberPageErrors()
  let stopped = false
  const origin = `http://127.0.0.1:${port}`

  const loop = async () => {
    while (!stopped) {
      try {
        const polled = await fetch(`${origin}/bridge/poll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        if (!polled.ok) throw new Error(`poll ${polled.status}`)
        const body = await polled.json() as { idle?: boolean; id?: string; action?: string; args?: Record<string, unknown> }
        if (!body?.id || !body.action || body.idle) continue
        let payload: { success: boolean; data?: unknown; error?: string }
        try {
          payload = { success: true, data: await runPageCommand(body.action, body.args || {}) }
        } catch (error) {
          payload = { success: false, error: error instanceof Error ? error.message : String(error) }
        }
        await fetch(`${origin}/bridge/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: body.id, ...payload }),
        })
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 800))
      }
    }
  }

  void loop()
  return () => {
    stopped = true
  }
}

function rememberPageErrors() {
  const lines: string[] = []
  window.__strideConsole = lines
  const report = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    lines.push(args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(' '))
    report(...args)
  }
  window.addEventListener('error', (event) => {
    window.__strideLastError = event.error instanceof Error ? event.error.stack || event.error.message : event.message
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    window.__strideLastError = reason instanceof Error ? reason.stack || reason.message : String(reason)
  })
}
