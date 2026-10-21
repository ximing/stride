// Polished update banner (T8.2, FEATURES 7.3). Renders the UpdateService state
// machine (services/update/update.service.ts): available → version + release notes +
// download, downloading → background progress bar, ready → restart, error →
// retry. `checking` stays silent, and outside Tauri the service never leaves
// `idle`, so the banner simply never mounts in plain-browser dev. Release
// notes render as plain-text lines on purpose — no markdown dependency.

import { observer, useService } from '@rabjs/react'
import { CircleArrowUp, CircleAlert, Download, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UpdateService } from '../../services/update/update.service'
import { Button, IconButton } from '../primitives/button'
import { Mark } from '../primitives/icon'
import './update-banner.css'

// Long release notes collapse to the first lines behind a toggle.
const COLLAPSED_NOTE_LINES = 4

function clampPercent(progress: number): number {
  return Math.round(Math.min(Math.max(progress, 0), 1) * 100)
}

export const UpdateBanner = observer(function UpdateBanner() {
  const { t } = useTranslation()
  const updates = useService(UpdateService)
  const [notesExpanded, setNotesExpanded] = useState(false)
  // "Later" hides the ready banner for this session only. dismiss() would
  // remember the version in localStorage and never re-offer it, which is too
  // strong for an already-downloaded update.
  const [snoozed, setSnoozed] = useState(false)

  const phase = updates.phase
  const version = updates.version
  useEffect(() => {
    setNotesExpanded(false)
    setSnoozed(false)
  }, [phase, version])

  // checking stays quiet; idle covers "nothing offered" and non-Tauri dev.
  if (phase === 'idle' || phase === 'checking') return null
  if (phase === 'ready' && snoozed) return null

  const noteLines = updates.body.split('\n')
  const collapsible = noteLines.length > COLLAPSED_NOTE_LINES
  const shownNotes = collapsible && !notesExpanded ? noteLines.slice(0, COLLAPSED_NOTE_LINES) : noteLines
  const percent = clampPercent(updates.progress)

  return (
    <div className="ubn" data-testid="update-banner" data-phase={phase}>
      <span className="ubn-icon" aria-hidden="true">
        {phase === 'available' && <Mark icon={CircleArrowUp} size={18} />}
        {phase === 'downloading' && <Mark icon={Download} size={18} />}
        {phase === 'ready' && <Mark icon={RefreshCw} size={18} />}
        {phase === 'error' && <Mark icon={CircleAlert} size={18} />}
      </span>

      <div className="ubn-body">
        {phase === 'available' && (
          <>
            <div className="ubn-title">{t('update.available', { version: updates.version })}</div>
            <div className="ubn-meta">
              {t('update.current', { version: updates.current })}
              {updates.date ? ` · ${updates.date}` : ''}
            </div>
            {updates.body && (
              <div className="ubn-notes" data-testid="update-notes">
                {shownNotes.map((line, index) => (
                  <p key={index}>{line || ' '}</p>
                ))}
                {collapsible && (
                  <Button
                    tone="quiet"
                    size="sm"
                    className="ubn-notes-toggle"
                    data-testid="update-notes-toggle"
                    onClick={() => {
                      setNotesExpanded((expanded) => !expanded)
                    }}
                  >
                    {notesExpanded ? t('update.collapse') : t('update.expand', { count: noteLines.length })}
                  </Button>
                )}
              </div>
            )}
          </>
        )}

        {phase === 'downloading' && (
          <>
            <div className="ubn-title">{t('update.downloading', { version: updates.version })}</div>
            <div className="ubn-progress-row">
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                data-testid="update-progress"
              >
                <span style={{ width: `${percent}%` }} />
              </div>
              <span className="ubn-percent" data-testid="update-progress-percent">
                {percent}%
              </span>
            </div>
            <div className="ubn-meta">{t('update.background')}</div>
          </>
        )}

        {phase === 'ready' && <div className="ubn-title">{t('update.ready', { version: updates.version })}</div>}

        {phase === 'error' && (
          <div className="ubn-title ubn-error" data-testid="update-error">
            {t('update.failed', { error: updates.error || t('update.unknown') })}
          </div>
        )}
      </div>

      <div className="ubn-actions">
        {phase === 'available' && (
          <>
            <Button
              tone="primary"
              size="sm"
              data-testid="update-download"
              icon={<Mark icon={Download} size={14} />}
              onClick={() => {
                void updates.download()
              }}
            >
              {t('update.download')}
            </Button>
            <Button
              tone="quiet"
              size="sm"
              data-testid="update-dismiss"
              onClick={() => {
                void updates.dismiss()
              }}
            >
              {t('update.ignore')}
            </Button>
          </>
        )}

        {phase === 'ready' && (
          <>
            <Button
              tone="primary"
              size="sm"
              data-testid="update-restart"
              icon={<Mark icon={RefreshCw} size={14} />}
              onClick={() => {
                void updates.confirm()
              }}
            >
              {t('update.restart', { version: updates.version })}
            </Button>
            <Button
              tone="quiet"
              size="sm"
              data-testid="update-later"
              onClick={() => {
                setSnoozed(true)
              }}
            >
              {t('update.later')}
            </Button>
          </>
        )}

        {phase === 'error' && (
          <>
            <Button
              tone="primary"
              size="sm"
              data-testid="update-retry"
              icon={<Mark icon={RefreshCw} size={14} />}
              onClick={() => {
                void updates.check()
              }}
            >
              {t('common.retry')}
            </Button>
            <IconButton
              icon={X}
              label={t('update.close')}
              className="ubn-close"
              data-testid="update-close"
              onClick={() => {
                void updates.dismiss()
              }}
            />
          </>
        )}
      </div>
    </div>
  )
})
