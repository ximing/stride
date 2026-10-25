import { Minus, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isTauriRuntime } from '../../services/platform/deep-link'
import { Mark } from '../primitives/icon'
import { Tip } from '../primitives/tooltip'

type WindowAction = 'close' | 'minimize' | 'zoom'

function runWindow(action: WindowAction) {
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      if (action === 'close') return win.close()
      if (action === 'minimize') return win.minimize()
      return win.toggleMaximize()
    })
    .catch((error: unknown) => {
      console.error('[window]', error)
    })
}

/**
 * Marks a Tauri window and drops the corner radius when it fills the screen.
 * A maximized or fullscreen window must stay square, or the corners show the desktop.
 */
export function bindDesktopWindowFrame(): void {
  if (!isTauriRuntime()) return
  if (document.documentElement.dataset.desktop === 'tauri') return
  document.documentElement.dataset.desktop = 'tauri'
  void import('@tauri-apps/api/window')
    .then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      const sync = async () => {
        const fill = (await win.isFullscreen()) || (await win.isMaximized())
        document.documentElement.toggleAttribute('data-window-fill', fill)
      }
      await sync()
      await win.onResized(() => { void sync() })
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
  if (!isTauriRuntime()) return null
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
