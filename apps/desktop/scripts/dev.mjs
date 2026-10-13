import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, STRIDE_API_PORT: process.env.STRIDE_API_PORT || '1421' }
const apiPort = Number(env.STRIDE_API_PORT)
const api = spawn('pnpm', ['exec', 'tsx', 'server/standalone.ts'], { cwd: root, env, stdio: 'inherit' })

function waitForPort(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (Date.now() - started > 20000) {
        reject(new Error(`API did not listen on ${port}`))
        return
      }
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end()
        resolve()
      })
      socket.on('error', () => setTimeout(tick, 80))
    }
    tick()
  })
}

const vite = await waitForPort(apiPort).then(() => spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', '1420', '--strictPort'],
  { cwd: root, env, stdio: 'inherit' },
))

function stop() {
  api.kill('SIGTERM')
  vite.kill('SIGTERM')
}

process.on('SIGINT', () => {
  stop()
  process.exit(0)
})
process.on('SIGTERM', () => {
  stop()
  process.exit(0)
})
api.on('exit', (code) => {
  if (code) {
    vite.kill('SIGTERM')
    process.exit(code)
  }
})
vite.on('exit', (code) => {
  api.kill('SIGTERM')
  process.exit(code ?? 0)
})
