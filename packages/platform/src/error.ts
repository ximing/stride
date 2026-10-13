export type PlatformErrorCode =
  | 'not-found'
  | 'already-exists'
  | 'escape'
  | 'unsupported'
  | 'git-unavailable'
  | 'io'

export class PlatformError extends Error {
  readonly code: PlatformErrorCode
  constructor(code: PlatformErrorCode, message: string) {
    super(message)
    this.name = 'PlatformError'
    this.code = code
  }
}
