import { electronBridge, type ElectronDisposer } from './index.ts'

export interface UpdateOffer {
  version: string
  body: string | null
  date: string | null
  currentVersion: string
}

export type UpdaterEvent =
  | { type: 'Started'; version: string }
  | { type: 'Progress'; version: string; percent: number; transferred: number; total: number }
  | { type: 'Finished'; version: string }

function isOffer(value: unknown): value is UpdateOffer {
  if (typeof value !== 'object' || value === null) return false
  const record = value as UpdateOffer
  return typeof record.version === 'string'
    && (record.body === null || typeof record.body === 'string')
    && (record.date === null || typeof record.date === 'string')
    && typeof record.currentVersion === 'string'
}

function isUpdaterEvent(value: unknown): value is UpdaterEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { type?: unknown; version?: unknown }
  if (typeof record.version !== 'string') return false
  if (record.type === 'Started' || record.type === 'Finished') return true
  if (record.type !== 'Progress') return false
  const progress = value as { percent?: unknown; transferred?: unknown; total?: unknown }
  return typeof progress.percent === 'number'
    && typeof progress.transferred === 'number'
    && typeof progress.total === 'number'
}

export async function checkForUpdate(): Promise<UpdateOffer | null> {
  const result: unknown = await electronBridge().invoke('updater:check')
  if (result === null) return null
  if (!isOffer(result)) throw new Error('Rejected update check')
  return result
}

export async function downloadUpdate(): Promise<void> {
  await electronBridge().invoke('updater:download')
}

export async function installUpdate(): Promise<void> {
  await electronBridge().invoke('updater:install')
}

export async function relaunchAfterUpdate(): Promise<void> {
  await electronBridge().invoke('updater:relaunch')
}

export function onUpdaterEvent(listener: (event: UpdaterEvent) => void): ElectronDisposer {
  return electronBridge().on('updater:event', (payload) => {
    if (isUpdaterEvent(payload)) listener(payload)
  })
}
