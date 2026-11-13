import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundleOnly = process.argv.includes('--bundle-only')

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  absWorkingDir: desktopRoot,
  logLevel: 'info',
}

await esbuild.build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'electron-dist/main.cjs',
})

await esbuild.build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'electron-dist/preload.cjs',
})

if (bundleOnly) {
  process.exit(0)
}

const builderBin = path.join(desktopRoot, 'node_modules', '.bin', 'electron-builder')
const configPath = path.join(desktopRoot, 'electron-builder.yml')
const builderArgs = process.argv.slice(2).filter((arg) => arg !== '--bundle-only')
const result = spawnSync(
  builderBin,
  ['--config', configPath, '--publish', 'never', ...builderArgs],
  {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: process.env,
  },
)

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
