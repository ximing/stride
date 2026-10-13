import { PlatformError } from './error.ts'

export interface UpdateOffer {
  version: string
  notes: string
}

export interface UpdaterBackend {
  readonly supported: boolean
  check(): Promise<UpdateOffer | null>
  download(onProgress: (loaded: number, total: number | null) => void): Promise<void>
  installAndRestart(): Promise<void>
}

function unsupported(): Promise<never> {
  return Promise.reject(new PlatformError('unsupported', 'Updates are not supported'))
}

export function unsupportedUpdater(): UpdaterBackend {
  const updater: UpdaterBackend = {
    supported: false,
    check: () => Promise.resolve(null),
    download: () => unsupported(),
    installAndRestart: () => unsupported(),
  }
  return updater
}
