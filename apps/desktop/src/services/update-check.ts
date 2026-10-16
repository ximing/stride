// Manual update-check entry point + launch auto-check scheduling (T8.3).
//
// - `scheduleUpdateAutocheck` runs one silent check a few seconds after
//   launch, gated on `settings.updates.autoCheck` read when the timer fires.
// - `UpdateCheckService.manualCheck` backs both manual entries (status bar
//   button and the `app.checkForUpdates` palette command) and keeps a small
//   self-clearing feedback line for the status bar.

import { has, register, resolve, Service } from '@rabjs/react'
import { SettingsService, UpdateService } from './panels.service'

export const UPDATE_AUTOCHECK_DELAY_MS = 3000
export const UPDATE_CHECK_FEEDBACK_CLEAR_MS = 2500

export type UpdateCheckFeedback = '' | 'checking' | 'up-to-date' | 'available'

export class UpdateCheckService extends Service {
  feedback: UpdateCheckFeedback = ''
  /** Version offered by the last manual check (for the feedback line). */
  feedbackVersion = ''

  private clearTimer: ReturnType<typeof setTimeout> | null = null

  get supported(): boolean {
    return resolve(UpdateService).updaterSupported
  }

  /** Small status-bar text. `checking` is shown by the button itself. */
  get feedbackText(): string {
    if (this.feedback === 'up-to-date') return '已是最新'
    if (this.feedback === 'available') {
      return this.feedbackVersion ? `发现新版本 v${this.feedbackVersion}，见顶部横幅` : '发现新版本，见顶部横幅'
    }
    return ''
  }

  private armClear() {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => {
      this.feedback = ''
      this.feedbackVersion = ''
      this.clearTimer = null
    }, UPDATE_CHECK_FEEDBACK_CLEAR_MS)
  }

  async manualCheck() {
    const updates = resolve(UpdateService)
    if (!updates.updaterSupported) return
    if (updates.phase === 'checking' || updates.phase === 'downloading') {
      // A check (or banner download) is already in flight: acknowledge it,
      // but only transiently — nothing of ours will clear this line when the
      // other flow finishes, so it must clear itself.
      this.feedback = 'checking'
      this.armClear()
      return
    }
    this.feedback = 'checking'
    // A manual check re-offers a version the user dismissed from the banner.
    await updates.check({ ignoreDismissed: true })
    if (updates.phase === 'available') {
      this.feedback = 'available'
      this.feedbackVersion = updates.version
      // The banner stays up; the small line only nudges towards it.
      this.armClear()
    } else if (updates.phase === 'idle') {
      // Also covers silently-swallowed network failures (T8.1 keeps those
      // indistinguishable from "no update" by design).
      this.feedback = 'up-to-date'
      this.armClear()
    } else {
      this.feedback = ''
    }
  }
}

export interface UpdateAutocheckOptions {
  delayMs?: number
  enabled?: () => boolean
  run?: () => Promise<unknown> | void
}

/**
 * Fire one silent update check `delayMs` after launch. The autoCheck switch
 * is read when the timer fires, so toggling it in Settings takes effect
 * immediately (and the next launch always obeys the saved value). No loading
 * UI, failures swallowed — UpdateService.check stays silent by design, and
 * outside Tauri it never leaves idle.
 */
export function scheduleUpdateAutocheck(options?: UpdateAutocheckOptions): () => void {
  const delayMs = options?.delayMs ?? UPDATE_AUTOCHECK_DELAY_MS
  const enabled =
    options?.enabled ?? (() => !has(SettingsService) || resolve(SettingsService).form.updates.autoCheck)
  const run = options?.run ?? (() => resolve(UpdateService).check())
  const timer = setTimeout(() => {
    if (!enabled()) return
    try {
      void Promise.resolve(run()).catch(() => undefined)
    } catch {
      // Silent by design: a failing launch check never surfaces.
    }
  }, delayMs)
  return () => clearTimeout(timer)
}

// Tests mount surfaces without main.tsx, so the global services must exist on import.
if (!has(UpdateService)) register(UpdateService)
if (!has(UpdateCheckService)) register(UpdateCheckService)
