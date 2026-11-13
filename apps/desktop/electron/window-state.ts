export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 840
export const WINDOW_STATE_FILE_NAME = 'window-state.json'

const MIN_WINDOW_SIZE = 320
const MAX_WINDOW_SIZE = 16_384

export interface PersistedWindowState {
  width: number
  height: number
  maximized: boolean
}

export function userDataDirectoryName(packaged: boolean): string {
  return packaged ? 'app.stride.desktop' : 'Stride Electron Dev'
}

export function defaultWindowState(): PersistedWindowState {
  return {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    maximized: false,
  }
}

export function parseWindowState(text: string): PersistedWindowState {
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) return defaultWindowState()
    const { width, height, maximized } = value
    if (!isValidSize(width) || !isValidSize(height) || typeof maximized !== 'boolean') {
      return defaultWindowState()
    }
    return {
      width: Math.round(width),
      height: Math.round(height),
      maximized,
    }
  } catch {
    return defaultWindowState()
  }
}

export function serializeWindowState(state: PersistedWindowState): string {
  return `${JSON.stringify({
    width: state.width,
    height: state.height,
    maximized: state.maximized,
  })}\n`
}

export function captureWindowState(
  bounds: { width: number; height: number },
  maximized: boolean,
): PersistedWindowState {
  if (!isValidSize(bounds.width) || !isValidSize(bounds.height)) {
    return { ...defaultWindowState(), maximized }
  }
  return {
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    maximized,
  }
}

function isValidSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_WINDOW_SIZE &&
    value <= MAX_WINDOW_SIZE
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
