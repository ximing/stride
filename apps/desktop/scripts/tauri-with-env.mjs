#!/usr/bin/env node
// Thin wrapper around the Tauri CLI that preloads the gitignored local
// `apps/desktop/.env` (holds TAURI_SIGNING_PRIVATE_KEY for local builds).
// The CLI itself does not read .env files; CI provides the same variables
// through repo secrets, so a missing file is a no-op.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const envPath = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '.env')

if (existsSync(envPath)) {
  const text = readFileSync(envPath, 'utf8')
  // dotenv-shaped lines: KEY=value or KEY="value with \n escapes".
  const line = text.match(/^TAURI_SIGNING_PRIVATE_KEY="((?:[^"\\]|\\.)*)"$/m)
  if (line) {
    process.env.TAURI_SIGNING_PRIVATE_KEY = line[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  const plain = text.match(/^([A-Z][A-Z0-9_]*)=(?!")(.*)$/gm) ?? []
  for (const entry of plain) {
    const eq = entry.indexOf('=')
    const key = entry.slice(0, eq)
    if (!(key in process.env)) process.env[key] = entry.slice(eq + 1)
  }
}

const result = spawnSync('tauri', process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
