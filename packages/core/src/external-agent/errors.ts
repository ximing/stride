export const EXTERNAL_AGENT_CODES = {
  unavailable: 'external-agent-unavailable',
  missing: 'external-agent-missing',
  handshake: 'external-agent-handshake',
  abort: 'external-agent-aborted',
  failed: 'external-agent-failed',
  stopped: 'external-agent-stopped',
  stoppedResume: 'external-agent-stopped-resume',
} as const

export type ExternalAgentFailure = keyof typeof EXTERNAL_AGENT_CODES

/** `message` is a stable code the chat panel translates. `detail` is the CLI or spawn text. */
export class ExternalAgentError extends Error {
  readonly failure: ExternalAgentFailure
  readonly detail: string

  /** JSON-RPC error code, when this failure came from an RPC error object. */
  readonly rpcCode?: number

  constructor(failure: ExternalAgentFailure, detail = '', rpcCode?: number) {
    super(EXTERNAL_AGENT_CODES[failure])
    this.name = 'ExternalAgentError'
    this.failure = failure
    this.detail = detail
    this.rpcCode = rpcCode
  }
}

export function classifySpawnError(error: unknown): ExternalAgentError {
  if (error instanceof ExternalAgentError) return error
  const detail = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
  if (code === 'ENOENT' || /ENOENT|not found/i.test(detail)) return new ExternalAgentError('missing', detail)
  if (detail === EXTERNAL_AGENT_CODES.unavailable) return new ExternalAgentError('unavailable', detail)
  return new ExternalAgentError('failed', detail)
}

export function asHandshakeError(error: unknown): ExternalAgentError {
  if (error instanceof ExternalAgentError) {
    if (error.failure === 'abort' || error.failure === 'missing' || error.failure === 'unavailable') return error
    if (/ENOENT|not found/i.test(error.detail)) return new ExternalAgentError('missing', error.detail)
    if (error.failure === 'handshake') return error
  }
  const detail = error instanceof Error ? error.message : 'handshake failed'
  if (/ENOENT|not found/i.test(detail)) return new ExternalAgentError('missing', detail)
  return new ExternalAgentError('handshake', detail)
}
