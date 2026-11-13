import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = readPort('STRIDE_DEV_PORT', 1420)
const cdpPort = readPort('STRIDE_CDP_PORT', 9222)
const devUrl = `http://127.0.0.1:${port}/`

const children = []
let closing = false

function readPort(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer port`)
  }
  const value = Number(raw)
  if (value < 1 || value > 65535) throw new Error(`${name} must be an integer port`)
  return value
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      stdio: 'inherit',
      ...options,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${signal ?? code ?? 'unknown'}`))
    })
  })
}

function startGroup(command, args, env) {
  const child = spawn(command, args, {
    cwd: desktopRoot,
    env,
    detached: true,
    stdio: 'inherit',
  })
  children.push(child)
  return child
}

function killGroup(child, signal) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error && error.code === 'ESRCH') return
    try {
      child.kill(signal)
    } catch {
      // The process group is already gone.
    }
  }
}

function shutdown(exitCode) {
  if (closing) return
  closing = true
  for (const child of children) killGroup(child, 'SIGTERM')
  const timer = setTimeout(() => {
    for (const child of children) killGroup(child, 'SIGKILL')
    process.exit(exitCode)
  }, 1500)
  const watch = setInterval(() => {
    const alive = children.some((child) => child.exitCode === null && child.signalCode === null)
    if (!alive) {
      clearInterval(watch)
      clearTimeout(timer)
      process.exit(exitCode)
    }
  }, 100)
}

function onChildExit(child, code, signal) {
  if (closing) return
  const exitCode = code === null ? 1 : code
  console.error(`[electron-dev] ${child.spawnargs?.[0] ?? 'child'} exited (${signal ?? code ?? 'unknown'})`)
  shutdown(exitCode)
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if ((res.statusCode ?? 500) < 500) {
          resolve()
          return
        }
        retry()
      })
      req.setTimeout(2000, () => {
        req.destroy()
      })
      req.on('error', retry)
    }
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Vite was not ready at ${url} within ${timeoutMs}ms`))
        return
      }
      setTimeout(attempt, 200)
    }
    attempt()
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('SIGHUP', () => shutdown(0))

try {
  await run(process.execPath, [path.join(desktopRoot, 'scripts/build-electron.mjs'), '--bundle-only'])

  const vite = startGroup('pnpm', [
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ], process.env)
  vite.on('exit', (code, signal) => onChildExit(vite, code, signal))

  await waitForHttp(devUrl, 60_000)
  console.log(`[electron-dev] Vite ready at ${devUrl}`)

  const electron = startGroup('pnpm', [
    'exec',
    'electron',
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${cdpPort}`,
    path.join(desktopRoot, 'electron-dist/main.cjs'),
  ], {
    ...process.env,
    STRIDE_DEV_URL: devUrl,
  })
  electron.on('exit', (code, signal) => onChildExit(electron, code, signal))
  console.log(`[electron-dev] Electron CDP http://127.0.0.1:${cdpPort}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  shutdown(1)
}
