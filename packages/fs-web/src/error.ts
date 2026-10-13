import { PlatformError } from '@stride/platform'

export function isDomError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === name
}

export function wrapIo(error: unknown, fallback: string): PlatformError {
  if (error instanceof PlatformError) return error
  const message = error instanceof Error && error.message ? error.message : fallback
  const wrapped = new PlatformError('io', message)
  Object.defineProperty(wrapped, 'cause', { value: error, configurable: true, writable: true })
  return wrapped
}
