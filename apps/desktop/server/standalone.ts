import http from 'node:http'
import { Desk } from './desk.ts'
import { exitCurrentProcess } from './handoff.ts'

const port = Number(process.env.STRIDE_API_PORT || 1421)
const desk = new Desk(process.env.STRIDE_SETTINGS_PATH, {
  handoff: () => exitCurrentProcess(),
})
await desk.whenReady()

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  })
  res.end(raw)
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, {})
    return
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  try {
    const body = req.method === 'GET' ? {} : JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
    const route = `${req.method} ${url.pathname}`
    if (route === 'POST /api/vault/open') {
      send(res, 200, await desk.open(String(body.path || '')))
      return
    }
    if (route === 'GET /api/vault') {
      send(res, 200, desk.snapshot())
      return
    }
    if (route === 'POST /api/notes') {
      send(res, 200, await desk.create(typeof body.title === 'string' ? body.title : undefined))
      return
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/notes/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/notes/'.length))
      const note = body.note as Parameters<Desk['save']>[0]
      note.id = id
      send(res, 200, await desk.save(note))
      return
    }
    if (route === 'POST /api/search') {
      send(res, 200, await desk.search(String(body.query || '')))
      return
    }
    if (route === 'POST /api/git/init') {
      send(res, 200, await desk.gitInit())
      return
    }
    if (route === 'GET /api/git/status') {
      send(res, 200, await desk.gitStatus())
      return
    }
    if (route === 'GET /api/git/diff') {
      send(res, 200, { diff: await desk.gitDiff(url.searchParams.get('id') || undefined) })
      return
    }
    if (route === 'POST /api/git/commit') {
      send(res, 200, { output: await desk.gitCommit(String(body.message || '')) })
      return
    }
    if (route === 'GET /api/git/history') {
      send(res, 200, { history: await desk.gitHistory(url.searchParams.get('id') || undefined) })
      return
    }
    if (route === 'POST /api/git/pull') {
      send(res, 200, await desk.gitPull())
      return
    }
    if (route === 'POST /api/git/push') {
      send(res, 200, { output: await desk.gitPush() })
      return
    }
    if (route === 'POST /api/git/remote') {
      await desk.gitRemote(String(body.url || ''))
      send(res, 200, { ok: true })
      return
    }
    if (route === 'POST /api/git/resolve') {
      send(res, 200, await desk.gitResolve(String(body.id || ''), body.side === 'theirs' ? 'theirs' : 'ours'))
      return
    }
    if (route === 'GET /api/settings') {
      send(res, 200, await desk.settingsPublic())
      return
    }
    if (route === 'PUT /api/settings') {
      send(res, 200, await desk.saveSettings(body as Parameters<Desk['saveSettings']>[0]))
      return
    }
    if (route === 'POST /api/chat') {
      send(res, 200, await desk.chatTurn(String(body.message || ''), typeof body.activeId === 'string' ? body.activeId : undefined))
      return
    }
    if (route === 'GET /api/updates') {
      send(res, 200, await desk.updateState())
      return
    }
    if (route === 'POST /api/updates/check') {
      send(res, 200, await desk.checkUpdates())
      return
    }
    if (route === 'POST /api/updates/download') {
      send(res, 200, await desk.downloadUpdate())
      return
    }
    if (route === 'POST /api/updates/dismiss') {
      send(res, 200, await desk.dismissUpdate())
      return
    }
    if (route === 'POST /api/updates/confirm') {
      send(res, 200, await desk.confirmUpdate())
      return
    }
    send(res, 404, { error: 'Not found' })
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`stride api http://127.0.0.1:${port}\n`)
})
