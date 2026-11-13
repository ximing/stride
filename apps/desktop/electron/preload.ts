import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  ELECTRON_BRIDGE_KEY,
  isElectronEventChannel,
  isElectronRequestChannel,
} from '@stride/electron-api'

function describeChannel(channel: unknown): string {
  if (typeof channel === 'string') return JSON.stringify(channel)
  if (channel === null) return 'null'
  return typeof channel
}

function invoke(channel: unknown, args?: unknown): Promise<unknown> {
  if (!isElectronRequestChannel(channel)) {
    return Promise.reject(
      new Error(`Rejected unknown Electron request channel: ${describeChannel(channel)}`),
    )
  }
  return ipcRenderer.invoke(channel, args)
}

function on(channel: unknown, listener: unknown): () => void {
  if (!isElectronEventChannel(channel)) {
    throw new Error(`Rejected unknown Electron event channel: ${describeChannel(channel)}`)
  }
  if (typeof listener !== 'function') {
    throw new Error(`Electron event listener for ${describeChannel(channel)} must be a function.`)
  }
  const notify = listener as (payload: unknown) => void
  const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
    notify(payload)
  }
  ipcRenderer.on(channel, wrapped)
  let settled = false
  return () => {
    if (settled) return
    settled = true
    ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld(ELECTRON_BRIDGE_KEY, {
  invoke,
  on,
})
