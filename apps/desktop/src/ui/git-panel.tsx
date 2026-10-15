import { CheckCircle, GitBranch, WarningCircle } from '@phosphor-icons/react'
import { useState } from 'react'
import type { GitChange } from '../../../../packages/core/src/git-changes.ts'
import { EmptyState } from './empty-state'
import { Modal, ModalContent } from './modal'

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-line diff-hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-line diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-line diff-del'
  return 'diff-line'
}

/** Renders a unified diff with add/del/hunk line colors. textContent is preserved verbatim. */
function DiffLines({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} className={diffLineClass(line)}>{index === 0 ? line : `\n${line}`}</span>
      ))}
    </>
  )
}

export function GitPanelView(props: {
  surface: 'unavailable' | 'disabled' | 'blocked' | 'needs-init' | 'ready'
  branch: string
  changes: GitChange[]
  selected: readonly string[]
  diff: string
  message: string
  ahead: number
  behind: number
  suggesting: boolean
  notice: string
  onToggle: (path: string) => void
  onMessage: (value: string) => void
  onOpenFileDiff: (path: string) => void
  onCommit: (paths: string[]) => void
  onSuggest: () => void
  onInit: () => void
  remote: string
  onRemote: (value: string) => void
  onAddRemote: () => void
  onPull: () => void
  onPush: () => void
  historyEntries?: readonly { hash: string; subject: string }[]
  historyText?: string
  onLoadHistory?: () => void
  onShowHistory?: (rev: string) => void
  onRestoreHistory?: () => void
  browserNeedsInit?: boolean
  error?: string
  onRetryError?: () => void
  onCommitOpenChange?: (open: boolean) => void
  conflicts?: readonly string[]
  onKeepSide?: (path: string, side: 'ours' | 'theirs') => void
}) {
  const [commitOpen, setCommitOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const historyEntries = props.historyEntries ?? []
  const conflicts = props.conflicts ?? []
  const selected = props.selected
  const canOpen = selected.length > 0
  const canSuggest = canOpen && !props.suggesting
  const canConfirm = canOpen && props.message.trim().length > 0
  return (
    <div data-testid="git-panel">
      <h2>Git</h2>
      {props.branch ? (
        <p className="meta" data-testid="git-branch">{props.branch}</p>
      ) : null}
      {props.surface === 'unavailable' && (
        <>
          <EmptyState
            compact
            icon={WarningCircle}
            title="Git is not available in the browser"
            testId="git-unavailable"
          />
          {props.browserNeedsInit ? (
            <p data-testid="git-needs-init">This vault is not a Git repository. Initialize it in the desktop app.</p>
          ) : null}
        </>
      )}
      {props.surface === 'disabled' && (
        <EmptyState compact icon={GitBranch} title="Git is turned off." testId="git-disabled" />
      )}
      {props.surface === 'blocked' && (
        <EmptyState compact tone="error" icon={WarningCircle} title={props.notice} testId="git-blocked" />
      )}
      {props.surface === 'needs-init' && (
        <EmptyState
          compact
          icon={GitBranch}
          title="This vault is not a Git repository."
          actionLabel="Initialize Git"
          actionTestId="git-init"
          onAction={() => props.onInit()}
          testId="git-needs-init-surface"
        />
      )}
      {props.surface === 'ready' && (
        <>
          <p className="meta" data-testid="git-ahead">ahead {props.ahead}</p>
          <p className="meta" data-testid="git-behind">behind {props.behind}</p>
          {props.notice ? <p className="meta" data-testid="git-notice">{props.notice}</p> : null}
          <label className="field">
            <span>Remote</span>
            <input
              type="text"
              data-testid="git-remote"
              value={props.remote}
              onChange={(event) => props.onRemote(event.target.value)}
            />
          </label>
          <div className="editor-tools">
            <button type="button" data-testid="git-remote-add" onClick={() => props.onAddRemote()}>Add remote</button>
            <button type="button" data-testid="git-pull" onClick={() => props.onPull()}>Pull</button>
            <button type="button" data-testid="git-push" onClick={() => props.onPush()}>Push</button>
          </div>
          {props.changes.length === 0 ? (
            <EmptyState compact icon={CheckCircle} title="Working tree clean" testId="git-clean" />
          ) : (
            props.changes.map((change) => (
              <div
                key={change.path}
                className="field"
                data-testid="git-change"
                data-path={change.path}
                onClick={() => props.onOpenFileDiff(change.path)}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(change.path)}
                  onChange={() => props.onToggle(change.path)}
                  onClick={(event) => event.stopPropagation()}
                />
                <span>{change.path}</span>
              </div>
            ))
          )}
          <pre className="diff" data-testid="git-diff"><DiffLines diff={props.diff} /></pre>
          <div className="editor-tools">
            <button type="button" data-testid="git-history" onClick={() => props.onLoadHistory?.()}>History</button>
          </div>
          {historyEntries.map((entry) => (
            <button
              key={entry.hash}
              type="button"
              data-testid="git-history-row"
              data-hash={entry.hash}
              onClick={() => props.onShowHistory?.(entry.hash)}
            >
              {entry.subject}
            </button>
          ))}
          <pre data-testid="git-history-text">{props.historyText ?? ''}</pre>
          <button type="button" data-testid="git-history-restore" onClick={() => setRestoreOpen(true)}>Restore</button>
          <Modal open={restoreOpen} onOpenChange={setRestoreOpen}>
            <ModalContent title="Restore version" description="Replace the current file with the shown revision. Nothing is committed.">
              <div className="editor-tools">
                <button
                  type="button"
                  data-testid="git-history-restore-confirm"
                  onClick={() => {
                    props.onRestoreHistory?.()
                    setRestoreOpen(false)
                  }}
                >
                  Restore
                </button>
              </div>
            </ModalContent>
          </Modal>
          <div className="editor-tools">
            <button
              type="button"
              className="primary"
              data-testid="git-commit-open"
              disabled={!canOpen}
              onClick={() => {
                if (!canOpen) return
                setCommitOpen(true)
              }}
            >
              Commit
            </button>
          </div>
          <Modal
            open={commitOpen}
            onOpenChange={(open) => {
              setCommitOpen(open)
              props.onCommitOpenChange?.(open)
            }}
          >
            <ModalContent title="Commit" description="Commit the selected paths.">
              <label className="field">
                <span>Message</span>
                <textarea
                  data-testid="git-commit-message"
                  value={props.message}
                  onChange={(event) => props.onMessage(event.target.value)}
                />
              </label>
              <div className="editor-tools">
                <button
                  type="button"
                  data-testid="git-suggest-message"
                  disabled={!canSuggest}
                  onClick={() => {
                    if (!canSuggest) return
                    props.onSuggest()
                  }}
                >
                  Suggest message
                </button>
                <button
                  type="button"
                  className="primary"
                  data-testid="git-commit-confirm"
                  disabled={!canConfirm}
                  onClick={() => {
                    if (!canConfirm) return
                    props.onCommit([...selected])
                  }}
                >
                  Commit
                </button>
              </div>
            </ModalContent>
          </Modal>
        </>
      )}
      {conflicts.length > 0 ? (
        <Modal
          open
          onOpenChange={() => {
            // Dismiss is not a choice. The list stays until each file keeps a side.
          }}
        >
          <ModalContent title="Resolve conflicts" description="Keep ours or theirs for each file.">
            <div data-testid="git-conflict">
              {conflicts.map((path) => (
                <div key={path} className="field">
                  <span>{path}</span>
                  <div className="editor-tools">
                    <button
                      type="button"
                      data-testid="git-keep-ours"
                      data-path={path}
                      onClick={() => props.onKeepSide?.(path, 'ours')}
                    >
                      Keep ours
                    </button>
                    <button
                      type="button"
                      data-testid="git-keep-theirs"
                      data-path={path}
                      onClick={() => props.onKeepSide?.(path, 'theirs')}
                    >
                      Keep theirs
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </ModalContent>
        </Modal>
      ) : null}
      {props.error ? (
        <div className="git-error-row">
          <p className="error" data-testid="git-error" role="alert">{props.error}</p>
          {props.onRetryError ? (
            <button type="button" className="save-retry" data-testid="git-error-retry" onClick={() => props.onRetryError?.()}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
