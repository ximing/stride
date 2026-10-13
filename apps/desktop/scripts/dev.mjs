import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', '1420', '--strictPort'],
  { cwd: root, stdio: 'inherit' },
)

function stop() {
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
vite.on('exit', (code) => {
  process.exit(code ?? 0)
})
