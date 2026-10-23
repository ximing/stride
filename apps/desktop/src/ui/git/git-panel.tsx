import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, GitBranch } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEDICATED_ERROR, type GitChange } from '@stride/core'
import { EmptyState } from '../primitives/empty-state'
import { Button } from '../primitives/button'
import { Mark } from '../primitives/icon'
import { Input } from '../primitives/input'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'

function RemoteFields(props: {
  remote: string
  onRemote: (value: string) => void
  onAddRemote: () => void
  onPull?: () => void
  onPush?: () => void
}) {
  const { t } = useTranslation()
  return (
    <section className="git-section" aria-label={t('git.remoteSettings')}>
      <Input
        label={t('git.remote')}
        type="text"
        data-testid="git-remote"
        placeholder="https://github.com/you/notes.git"
        spellCheck={false}
        value={props.remote}
        onChange={(event) => props.onRemote(event.target.value)}
      />
      <div className="editor-tools git-actions">
        <Button size="sm" tone="secondary" data-testid="git-remote-add" onClick={() => props.onAddRemote()}>{t('git.addRemote')}</Button>
        {props.onPull ? (
          <Button size="sm" tone="secondary" data-testid="git-pull" onClick={() => props.onPull?.()}>{t('git.pull')}</Button>
        ) : null}
        {props.onPush ? (
          <Button size="sm" tone="secondary" data-testid="git-push" onClick={() => props.onPush?.()}>{t('git.push')}</Button>
        ) : null}
      </div>
    </section>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-line diff-hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-line diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-line diff-del'
  return 'diff-line'
}

/** Porcelain code -> one-letter badge with a semantic tone. */
function changeBadge(change: GitChange): { label: string; tone: string } {
  if (change.unmerged) return { label: '!', tone: 'is-unmerged' }
  if (change.untracked) return { label: '?', tone: 'is-untracked' }
  if (change.code.includes('D')) return { label: 'D', tone: 'is-deleted' }
  if (change.code.includes('A')) return { label: 'A', tone: 'is-added' }
  if (change.code.includes('R')) return { label: 'R', tone: 'is-renamed' }
  return { label: 'M', tone: 'is-modified' }
}

function DialogCopy(props: {
  notice?: string
  error?: string
  copy: (value: string) => string
}) {
  if (!props.notice && !props.error) return null
  return (
    <>
      {props.notice ? (
        <p className="meta git-notice git-modal-note" data-testid="git-notice">{props.copy(props.notice)}</p>
      ) : null}
      {props.error ? (
        <p className="error git-modal-error" data-testid="git-error" role="alert">{props.copy(props.error)}</p>
      ) : null}
    </>
  )
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
  const { t } = useTranslation()
  const [commitOpen, setCommitOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const statusCopy = (value: string) => {
    if (value === 'Git is not available in the browser') return t('git.unavailable')
    if (value === 'Git is turned off.') return t('git.off')
    if (value === DEDICATED_ERROR) return t('git.broadFolder')
    if (value === 'Add a model provider, base URL, model, and key in Settings') return t('chat.needProvider')
    return value
  }
  const historyEntries = props.historyEntries ?? []
  const conflicts = props.conflicts ?? []
  const selected = props.selected
  const canOpen = selected.length > 0
  const canSuggest = canOpen && !props.suggesting
  const canConfirm = canOpen && props.message.trim().length > 0
  return (
    <div className="git-panel" data-testid="git-panel">
      <h2 className="panel-heading">{t('git.heading')}</h2>
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
            title={t('git.unavailable')}
            testId="git-unavailable"
          />
          {props.browserNeedsInit ? (
            <p data-testid="git-needs-init">{t('git.needsInitBrowser')}</p>
          ) : null}
        </>
      )}
      {props.surface === 'disabled' && (
        <EmptyState compact icon={GitBranch} title={t('git.off')} testId="git-disabled" />
      )}
      {props.surface === 'blocked' && (
        <EmptyState compact tone="error" icon={CircleAlert} title={statusCopy(props.notice)} testId="git-blocked" />
      )}
      {props.surface === 'needs-init' && (
        <>
          <EmptyState
            compact
            icon={GitBranch}
            title={t('git.notRepo')}
            actionLabel={t('git.init')}
            actionTestId="git-init"
            onAction={() => props.onInit()}
            testId="git-needs-init-surface"
          />
          <RemoteFields
            remote={props.remote}
            onRemote={props.onRemote}
            onAddRemote={props.onAddRemote}
          />
        </>
      )}
      {props.surface === 'ready' && (
        <>
          <div className="git-sync-stats">
            <p className="meta" data-testid="git-ahead"><Mark icon={ArrowUp} size={13} />{t('git.ahead', { count: props.ahead })}</p>
            <p className="meta" data-testid="git-behind"><Mark icon={ArrowDown} size={13} />{t('git.behind', { count: props.behind })}</p>
          </div>
          {props.notice ? <p className="meta git-notice" data-testid="git-notice">{statusCopy(props.notice)}</p> : null}
          <RemoteFields
            remote={props.remote}
            onRemote={props.onRemote}
            onAddRemote={props.onAddRemote}
            onPull={props.onPull}
            onPush={props.onPush}
          />
          <section className="git-section" aria-label={t('git.workingTree')}>
            <h3 className="panel-subheading">{t('git.changes')}</h3>
            <div className="git-changes">
              {props.changes.length === 0 ? (
                <EmptyState compact icon={CircleCheck} title={t('git.clean')} testId="git-clean" />
              ) : (
                props.changes.map((change) => {
                  const badge = changeBadge(change)
                  return (
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
                      <span className={`git-change-badge ${badge.tone}`} aria-hidden="true">{badge.label}</span>
                      <span className="git-change-path">{change.path}</span>
                    </div>
                  )
                })
              )}
            </div>
          </section>
          <pre className="diff git-diff" data-testid="git-diff"><DiffLines diff={props.diff} /></pre>
          <section className="git-section" aria-label={t('git.history')}>
            <div className="git-section-head">
              <h3 className="panel-subheading">{t('git.history')}</h3>
              <Button size="sm" tone="quiet" data-testid="git-history" onClick={() => props.onLoadHistory?.()}>{t('git.history')}</Button>
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
            <Button size="sm" tone="secondary" data-testid="git-history-restore" onClick={() => setRestoreOpen(true)}>{t('git.restore')}</Button>
          </section>
          <Modal open={restoreOpen} onOpenChange={setRestoreOpen}>
            <ModalContent title={t('git.restoreTitle')} description={t('git.restoreBody')}>
              <div className="sd-modal-actions">
                <ModalClose asChild>
                  <Button tone="secondary">{t('common.cancel')}</Button>
                </ModalClose>
                <Button
                  tone="danger"
                  data-testid="git-history-restore-confirm"
                  onClick={() => {
                    props.onRestoreHistory?.()
                    setRestoreOpen(false)
                  }}
                >
                  {t('git.restore')}
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
              {t('git.commit')}
            </Button>
          </div>
          <Modal
            open={commitOpen}
            onOpenChange={(open) => {
              setCommitOpen(open)
              props.onCommitOpenChange?.(open)
            }}
          >
            <ModalContent title={t('git.commit')} description={t('git.commitBody')}>
              <label className="field git-commit-message-field">
                <span>{t('git.message')}</span>
                <textarea
                  className="git-commit-message"
                  data-testid="git-commit-message"
                  value={props.message}
                  onChange={(event) => props.onMessage(event.target.value)}
                />
              </label>
              <DialogCopy notice={props.notice} error={props.error} copy={statusCopy} />
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
                  {t('git.suggest')}
                </Button>
                <ModalClose asChild>
                  <Button size="sm" tone="secondary">{t('common.cancel')}</Button>
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
                  {t('git.commit')}
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
          <ModalContent dismissible={false} title={t('git.conflictsTitle')} description={t('git.conflictsBody')}>
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
                      {t('git.keepOurs')}
                    </Button>
                    <Button
                      size="sm"
                      tone="secondary"
                      data-testid="git-keep-theirs"
                      data-path={path}
                      onClick={() => props.onKeepSide?.(path, 'theirs')}
                    >
                      {t('git.keepTheirs')}
                    </Button>
                  </div>
                </div>
              ))}
              <DialogCopy error={props.error} copy={statusCopy} />
            </div>
          </ModalContent>
        </Modal>
      ) : null}
      {props.error ? (
        <div className="git-error-row">
          <p className="error" data-testid="git-error" role="alert">{statusCopy(props.error)}</p>
          {props.onRetryError ? (
            <Button size="sm" tone="secondary" className="save-retry" data-testid="git-error-retry" onClick={() => props.onRetryError?.()}>
              {t('common.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
