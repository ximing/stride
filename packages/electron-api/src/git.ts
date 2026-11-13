import { electronBridge, type ElectronBridge } from './index.ts'

/** Non-zero exits stay in this object so the renderer can build a GitError without dropping output. */
export interface GitExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

function bridge(): ElectronBridge {
  return electronBridge()
}

function isGitExecResult(value: unknown): value is GitExecResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const codeOk = record.code === null || (typeof record.code === 'number' && Number.isInteger(record.code))
  const signalOk = record.signal === null || typeof record.signal === 'string'
  return codeOk && signalOk && typeof record.stdout === 'string' && typeof record.stderr === 'string'
}

export async function execGit(cwd: string, args: string[], env?: Record<string, string>): Promise<GitExecResult> {
  const result = await bridge().invoke('git:exec', env === undefined ? { cwd, args } : { cwd, args, env })
  if (!isGitExecResult(result)) throw new Error('Rejected invalid git result')
  return result
}
