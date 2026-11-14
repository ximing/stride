import { readdir, stat } from 'node:fs/promises'
import { delimiter, join, sep } from 'node:path'

export interface DetectedAgentExecutables {
  grok: string | null
  claude: string | null
  codex: string | null
}

const NAMES = ['grok', 'claude', 'codex'] as const

type AgentName = (typeof NAMES)[number]
type Version = [number, number, number]

interface VersionBin {
  version: Version
  dir: string
}

function candidateNames(name: string): string[] {
  if (process.platform === 'win32') return [name, `${name}.exe`, `${name}.cmd`]
  return [name]
}

function parseVersion(name: string): Version | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(name)
  if (!match) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareVersion(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

async function readNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function isExecutableFile(file: string): Promise<boolean> {
  // Skip the nested Codex vendor binary. The shim in installation/bin is the one to store.
  if (file.split(sep).includes('node_modules')) return false
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    if (process.platform === 'win32') return true
    return (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

async function firstNamed(dir: string, name: string): Promise<string | null> {
  for (const fileName of candidateNames(name)) {
    const file = join(dir, fileName)
    if (await isExecutableFile(file)) return file
  }
  return null
}

async function firstInPath(pathEnv: string | undefined, name: string): Promise<string | null> {
  if (!pathEnv) return null
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const file = await firstNamed(dir, name)
    if (file) return file
  }
  return null
}

function fnmRoots(home: string, fnmDir: string | undefined): string[] {
  const roots = [
    join(home, '.local', 'share', 'fnm', 'node-versions'),
    join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
  ]
  const extra = fnmDir?.trim()
  if (extra) roots.push(join(extra, 'node-versions'))
  return [...new Set(roots)]
}

async function versionBins(home: string, fnmDir: string | undefined): Promise<VersionBin[]> {
  const bins: VersionBin[] = []
  for (const root of fnmRoots(home, fnmDir)) {
    for (const name of await readNames(root)) {
      const version = parseVersion(name)
      if (!version) continue
      bins.push({ version, dir: join(root, name, 'installation', 'bin') })
    }
  }
  const nvm = join(home, '.nvm', 'versions', 'node')
  for (const name of await readNames(nvm)) {
    const version = parseVersion(name)
    if (!version) continue
    bins.push({ version, dir: join(nvm, name, 'bin') })
  }
  bins.sort((left, right) => compareVersion(right.version, left.version))
  return bins
}

async function detectName(
  name: AgentName,
  pathEnv: string | undefined,
  versions: readonly VersionBin[],
  shims: readonly string[],
): Promise<string | null> {
  const onPath = await firstInPath(pathEnv, name)
  if (onPath) return onPath
  for (const bin of versions) {
    const file = await firstNamed(bin.dir, name)
    if (file) return file
  }
  for (const dir of shims) {
    const file = await firstNamed(dir, name)
    if (file) return file
  }
  return null
}

/** PATH wins. Otherwise the highest fnm or nvm version, then a Volta or asdf shim. */
export async function detectAgentExecutables(input: {
  home: string
  pathEnv?: string
  fnmDir?: string
}): Promise<DetectedAgentExecutables> {
  const versions = await versionBins(input.home, input.fnmDir)
  const shims = [join(input.home, '.volta', 'bin'), join(input.home, '.asdf', 'shims')]
  const found = {} as DetectedAgentExecutables
  for (const name of NAMES) {
    found[name] = await detectName(name, input.pathEnv, versions, shims)
  }
  return found
}
