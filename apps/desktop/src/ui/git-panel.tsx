import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, GitBranch } from 'lucide-react'
import { useState } from 'react'
import type { GitChange } from '../../../../packages/core/src/git-changes.ts'
import { EmptyState } from './empty-state'
import { Button } from './button'
import { Mark } from './icon'
import { Input } from './input'
import { Modal, ModalClose, ModalContent } from './modal'

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
    <div className="git-panel" data-testid="git-panel">
      <h2 className="panel-heading">Git</h2>
      {props.branch ? (
        <div className="git-branch-row">
          <Mark icon={GitBranch} size={14} />
          <p className="meta" data-testid="git-branch">{props.branch}</p>
        </div>
      ) : null}
      {props.surface === 'unavailable' && (
        <>
          <EmptyState
            compact
            icon={CircleAlert}
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
        <EmptyState compact tone="error" icon={CircleAlert} title={props.notice} testId="git-blocked" />
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
          <div className="git-sync-stats">
            <p className="meta" data-testid="git-ahead"><Mark icon={ArrowUp} size={13} />ahead {props.ahead}</p>
            <p className="meta" data-testid="git-behind"><Mark icon={ArrowDown} size={13} />behind {props.behind}</p>
          </div>
          {props.notice ? <p className="meta git-notice" data-testid="git-notice">{props.notice}</p> : null}
          <section className="git-section" aria-label="Remote settings">
            <Input
              label="Remote"
              type="text"
              data-testid="git-remote"
              value={props.remote}
              onChange={(event) => props.onRemote(event.target.value)}
            />
            <div className="editor-tools git-actions">
              <Button size="sm" tone="secondary" data-testid="git-remote-add" onClick={() => props.onAddRemote()}>Add remote</Button>
              <Button size="sm" tone="secondary" data-testid="git-pull" onClick={() => props.onPull()}>Pull</Button>
              <Button size="sm" tone="secondary" data-testid="git-push" onClick={() => props.onPush()}>Push</Button>
            </div>
          </section>
          <section className="git-section" aria-label="Working tree">
            <h3 className="panel-subheading">Changes</h3>
            <div className="git-changes">
              {props.changes.length === 0 ? (
                <EmptyState compact icon={CircleCheck} title="Working tree clean" testId="git-clean" />
              ) : (
                props.changes.map((change) => (
                  <div
                    key={change.path}
                    className={selected.includes(change.path) ? 'field git-change is-selected' : 'field git-change'}
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
                    <span className="git-change-path">{change.path}</span>
                  </div>
                ))
              )}
            </div>
          </section>
          <pre className="diff git-diff" data-testid="git-diff"><DiffLines diff={props.diff} /></pre>
          <section className="git-section" aria-label="History">
            <div className="git-section-head">
              <h3 className="panel-subheading">History</h3>
              <Button size="sm" tone="quiet" data-testid="git-history" onClick={() => props.onLoadHistory?.()}>History</Button>
            </div>
            <div className="git-history-list">
              {historyEntries.map((entry) => (
                <Button
                  key={entry.hash}
                  className="git-history-row"
                  size="sm"
                  tone="quiet"
                  data-testid="git-history-row"
                  data-hash={entry.hash}
                  onClick={() => props.onShowHistory?.(entry.hash)}
                >
                  {entry.subject}
                </Button>
              ))}
            </div>
            <pre className="history git-history-text" data-testid="git-history-text">{props.historyText ?? ''}</pre>
            <Button size="sm" tone="secondary" data-testid="git-history-restore" onClick={() => setRestoreOpen(true)}>Restore</Button>
          </section>
          <Modal open={restoreOpen} onOpenChange={setRestoreOpen}>
            <ModalContent title="Restore version" description="Replace the current file with the shown revision. Nothing is committed.">
              <div className="sd-modal-actions">
                <ModalClose asChild>
                  <Button tone="secondary">Cancel</Button>
                </ModalClose>
                <Button
                  tone="danger"
                  data-testid="git-history-restore-confirm"
                  onClick={() => {
                    props.onRestoreHistory?.()
                    setRestoreOpen(false)
                  }}
                >
                  Restore
                </Button>
              </div>
            </ModalContent>
          </Modal>
          <div className="editor-tools git-commit-action">
            <Button
              size="sm"
              tone="primary"
              data-testid="git-commit-open"
              disabled={!canOpen}
              onClick={() => {
                if (!canOpen) return
                setCommitOpen(true)
              }}
            >
              Commit
            </Button>
          </div>
          <Modal
            open={commitOpen}
            onOpenChange={(open) => {
              setCommitOpen(open)
              props.onCommitOpenChange?.(open)
            }}
          >
            <ModalContent title="Commit" description="Commit the selected paths.">
              <label className="field git-commit-message-field">
                <span>Message</span>
                <textarea
                  className="git-commit-message"
                  data-testid="git-commit-message"
                  value={props.message}
                  onChange={(event) => props.onMessage(event.target.value)}
                />
              </label>
              <div className="sd-modal-actions">
                <Button
                  size="sm"
                  tone="secondary"
                  data-testid="git-suggest-message"
                  disabled={!canSuggest}
                  onClick={() => {
                    if (!canSuggest) return
                    props.onSuggest()
                  }}
                >
                  Suggest message
                </Button>
                <ModalClose asChild>
                  <Button size="sm" tone="secondary">Cancel</Button>
                </ModalClose>
                <Button
                  size="sm"
                  tone="primary"
                  data-testid="git-commit-confirm"
                  disabled={!canConfirm}
                  onClick={() => {
                    if (!canConfirm) return
                    props.onCommit([...selected])
                  }}
                >
                  Commit
                </Button>
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
                <div key={path} className="field git-conflict-row">
                  <span>{path}</span>
                  <div className="editor-tools">
                    <Button
                      size="sm"
                      tone="secondary"
                      data-testid="git-keep-ours"
                      data-path={path}
                      onClick={() => props.onKeepSide?.(path, 'ours')}
                    >
                      Keep ours
                    </Button>
                    <Button
                      size="sm"
                      tone="secondary"
                      data-testid="git-keep-theirs"
                      data-path={path}
                      onClick={() => props.onKeepSide?.(path, 'theirs')}
                    >
                      Keep theirs
                    </Button>
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
            <Button size="sm" tone="secondary" className="save-retry" data-testid="git-error-retry" onClick={() => props.onRetryError?.()}>
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
