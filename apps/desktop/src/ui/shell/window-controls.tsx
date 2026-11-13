import type { WindowStateSnapshot } from '@stride/electron-api'
import { Minus, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isDesktopRuntime } from '../../services/platform/runtime'
import { Mark } from '../primitives/icon'
import { Tip } from '../primitives/tooltip'

type WindowAction = 'close' | 'minimize' | 'zoom'

function isWindowState(value: unknown): value is WindowStateSnapshot {
  if (!value || typeof value !== 'object') return false
  const state = value as WindowStateSnapshot
  return typeof state.maximized === 'boolean'
    && typeof state.minimized === 'boolean'
    && typeof state.fullscreen === 'boolean'
}

function runWindow(action: WindowAction) {
  const mapped = action === 'zoom' ? 'toggleMaximize' : action
  void import('@stride/electron-api')
    .then(({ electronBridge }) => electronBridge().invoke('window:control', { action: mapped }))
    .catch((error: unknown) => {
      console.error('[window]', error)
    })
}

/**
 * Marks a desktop window and drops the corner radius when it fills the screen.
 * index.html sets `data-desktop` before the bundle so the plate is already
 * rounded; this keeps the filled-window override in step.
 * A maximized or fullscreen window must stay square, or the corners show the desktop.
 */
export function bindDesktopWindowFrame(): void {
  if (!isDesktopRuntime()) return
  document.documentElement.dataset.desktop = 'electron'
  void import('@stride/electron-api')
    .then(({ electronBridge }) => {
      const ipc = electronBridge()
      const sync = (state: WindowStateSnapshot) => {
        const fill = state.fullscreen || state.maximized
        document.documentElement.toggleAttribute('data-window-fill', fill)
      }
      ipc.on('window:state', (payload) => {
        if (isWindowState(payload)) sync(payload)
      })
      return ipc.invoke('window:state').then((payload) => {
        if (isWindowState(payload)) sync(payload)
      })
    })
    .catch((error: unknown) => {
      console.error('[window]', error)
    })
}

const CONTROLS: { action: WindowAction; label: 'window.close' | 'window.minimize' | 'window.zoom'; icon: typeof X; testId: string }[] = [
  { action: 'close', label: 'window.close', icon: X, testId: 'window-close' },
  { action: 'minimize', label: 'window.minimize', icon: Minus, testId: 'window-minimize' },
  { action: 'zoom', label: 'window.zoom', icon: Plus, testId: 'window-zoom' },
]

/**
 * Custom window buttons for the desktop shell. The browser has no window to
 * control, so this renders nothing there and the rest of the chrome stays put.
 */
export function WindowControls() {
  const { t } = useTranslation()
  if (!isDesktopRuntime()) return null
  return (
    <div className="window-controls" role="group" aria-label={t('window.controls')} data-testid="window-controls">
      {CONTROLS.map((control) => (
        <Tip key={control.action} content={t(control.label)}>
          <button
            type="button"
            className={`window-control window-control-${control.action}`}
            data-testid={control.testId}
            aria-label={t(control.label)}
            onClick={() => runWindow(control.action)}
          >
            <Mark icon={control.icon} size={8} />
          </button>
        </Tip>
      ))}
    </div>
  )
}
