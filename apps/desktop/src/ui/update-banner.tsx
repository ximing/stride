// Polished update banner (T8.2, FEATURES 7.3). Renders the UpdateService state
// machine (services/panels.service.ts): available → version + release notes +
// download, downloading → background progress bar, ready → restart, error →
// retry. `checking` stays silent, and outside Tauri the service never leaves
// `idle`, so the banner simply never mounts in plain-browser dev. Release
// notes render as plain-text lines on purpose — no markdown dependency.

import { observer, useService } from '@rabjs/react'
import { CircleArrowUp, CircleAlert, Download, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { UpdateService } from '../services/panels.service'
import { Button, IconButton } from './button'
import { Mark } from './icon'
import './update-banner.css'

// Long release notes collapse to the first lines behind a toggle.
const COLLAPSED_NOTE_LINES = 4

function clampPercent(progress: number): number {
  return Math.round(Math.min(Math.max(progress, 0), 1) * 100)
}

export const UpdateBanner = observer(function UpdateBanner() {
  const updates = useService(UpdateService)
  const [notesExpanded, setNotesExpanded] = useState(false)
  // "稍后" hides the ready banner for this session only. dismiss() would
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
            <div className="ubn-title">新版本 v{updates.version} 可用</div>
            <div className="ubn-meta">
              当前 v{updates.current}
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
                    {notesExpanded ? '收起' : `展开全部（${noteLines.length} 行）`}
                  </Button>
                )}
              </div>
            )}
          </>
        )}

        {phase === 'downloading' && (
          <>
            <div className="ubn-title">正在下载 v{updates.version}</div>
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
            <div className="ubn-meta">后台下载中，不影响使用</div>
          </>
        )}

        {phase === 'ready' && <div className="ubn-title">v{updates.version} 已就绪</div>}

        {phase === 'error' && (
          <div className="ubn-title ubn-error" data-testid="update-error">
            更新失败：{updates.error || '未知错误'}
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
              下载更新
            </Button>
            <Button
              tone="quiet"
              size="sm"
              data-testid="update-dismiss"
              onClick={() => {
                void updates.dismiss()
              }}
            >
              忽略此版本
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
              重启以更新到 v{updates.version}
            </Button>
            <Button
              tone="quiet"
              size="sm"
              data-testid="update-later"
              onClick={() => {
                setSnoozed(true)
              }}
            >
              稍后
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
              重试
            </Button>
            <IconButton
              icon={X}
              label="关闭"
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
