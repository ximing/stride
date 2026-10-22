import { observer, useService } from '@rabjs/react'
import { Book, BookOpen, FolderOpen, FolderPlus, GitBranch, Notebook } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NoteEditor } from './editor'
import { LayoutService } from './services/layout/layout.service'
import { isTauriRuntime } from './services/platform/deep-link'
import { GitService } from './services/git/git.service'
import { SettingsService } from './services/settings/settings.service'
import { VaultService } from './services/vault/vault.service'
import { folderTitle } from './services/vault/vault-registry'
import { Button } from './ui/primitives/button'
import { CommandPalette } from './ui/overlays/command-palette'
import { EmptyState } from './ui/primitives/empty-state'
import { Mark } from './ui/primitives/icon'
import { Input } from './ui/primitives/input'
import { NoteList, relativeDay } from './ui/note-list/note-list'
import { QuickOpen } from './ui/overlays/quick-open'
import { ResizeHandle } from './ui/shell/resize-handle'
import { PanelRail, RightPanel } from './ui/panels/right-panel'
import { SearchPanel } from './ui/overlays/search-panel'
import { SettingsPage } from './ui/settings/settings-page'
import { Rail } from './ui/shell/sidebar'
import { CollapsedChrome, RailChrome } from './ui/shell/rail-chrome'
import { StatusBar } from './ui/shell/status-bar'
import { TabStrip } from './ui/shell/tab-strip'
import { TooltipProvider } from './ui/primitives/tooltip'
import { UpdateBanner } from './ui/shell/update-banner'
import { WindowControls } from './ui/shell/window-controls'

// Re-exports keep existing test imports (`from '../app'`) stable.
export { Rail } from './ui/shell/sidebar'
export { GitStatusBadge } from './ui/shell/status-bar'
export { UpdateBanner } from './ui/shell/update-banner'

const Chooser = observer(function Chooser() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const git = useService(GitService)
  const desktop = isTauriRuntime()
  return (
    <section className="chooser" data-testid="vault-surface">
      {desktop ? (
        <div className="chooser-window" data-tauri-drag-region="deep">
          <WindowControls />
          <div className="rail-drag" />
        </div>
      ) : null}
      <div className="chooser-panel">
        <div className="chooser-copy">
          <div className="chooser-brand">
            <span className="chooser-brand-mark" aria-hidden="true">
              <Mark icon={Notebook} size={22} />
            </span>
            <h1>Stride</h1>
          </div>
          <p className="chooser-lead">{t('chooser.lead')}</p>
          <p className="chooser-description">{t('chooser.description')}</p>
        </div>
        <form
          className="chooser-form"
          onSubmit={(event) => {
            event.preventDefault()
          }}
        >
          {vault.recentVaults.length > 0 && (
            <div className="chooser-recent" data-testid="recent-vaults">
              <div className="chooser-section-label">{t('chooser.recent')}</div>
              <div className="chooser-recent-list" role="list">
                {vault.recentVaults.map((entry) => {
                  const title = folderTitle(entry.label)
                  const path = title === entry.label ? '' : entry.label
                  const opened = relativeDay(Date.parse(entry.lastOpened), Date.now())
                  return (
                    <div key={entry.id} role="listitem">
                      <Button
                        tone="quiet"
                        size="md"
                        className="chooser-recent-item"
                        data-testid="recent-vault"
                        data-vault-id={entry.id}
                        title={entry.label}
                        icon={<Mark icon={Book} size={16} />}
                        onClick={() => void vault.switchVault(entry.id)}
                      >
                        <span className="chooser-recent-copy">
                          <span className="chooser-recent-label">{title}</span>
                          {path ? <span className="chooser-recent-path">{path}</span> : null}
                        </span>
                        {opened ? <span className="chooser-recent-time">{opened}</span> : null}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <div className="chooser-start">
            <div className="chooser-section-label">{t('chooser.start')}</div>
            <div className="chooser-actions">
              <Button
                tone="primary"
                size="lg"
                icon={<Mark icon={FolderPlus} size={16} />}
                data-testid="new-vault"
                onClick={() => void vault.createNewVault()}
              >
                {t('chooser.newVault')}
              </Button>
              <Button
                tone="quiet"
                size="lg"
                icon={<Mark icon={FolderOpen} size={16} />}
                data-testid="open-vault"
                onClick={() => void vault.openFromDraft()}
              >
                {t('chooser.openVault')}
              </Button>
              <Button
                tone="quiet"
                size="lg"
                icon={<Mark icon={BookOpen} size={16} />}
                data-testid="clone-sample"
                onClick={() => void vault.cloneSampleVault()}
              >
                {t('chooser.cloneSample')}
              </Button>
            </div>
          </div>
          <div className="chooser-git">
            <div className="chooser-git-row">
              <Input
                label={t('chooser.gitUrl')}
                className="chooser-git-input"
                data-testid="git-clone-url"
                placeholder="https://github.com/you/notes.git"
                value={git.cloneUrl}
                onChange={(event) => git.setCloneUrl(event.target.value)}
                spellCheck={false}
              />
              <Button
                tone="quiet"
                size="md"
                icon={<Mark icon={GitBranch} size={16} />}
                data-testid="git-clone"
                disabled={git.surface === 'unavailable'}
                onClick={() => {
                  if (git.surface === 'unavailable') return
                  void git.cloneRemote()
                }}
              >
                {t('chooser.clone')}
              </Button>
            </div>
            {git.surface === 'unavailable' && (
              <p className="chooser-hint" data-testid="git-clone-unavailable">{t('chooser.cloneNeedsDesktop')}</p>
            )}
            {git.cloneError && <p className="error chooser-error" data-testid="git-clone-error" role="alert">{git.cloneError}</p>}
          </div>
          {vault.error && <p className="error chooser-error" data-testid="vault-error" role="alert">{vault.error}</p>}
        </form>
      </div>
    </section>
  )
})

/** Save feedback beside the note title: "saved" confirms briefly then folds
   away (the element collapses via `.save-status:empty`); pending/saving and
   error states stay visible until they resolve. */
const SaveStatus = observer(function SaveStatus() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (vault.saveStatus !== 'saved') {
      setShowSaved(false)
      return
    }
    setShowSaved(true)
    const timer = setTimeout(() => setShowSaved(false), 2600)
    return () => clearTimeout(timer)
  }, [vault.saveStatus])
  const status = vault.saveStatus
  return (
    <>
      <span className={status === 'error' ? 'save-status is-error' : 'save-status'} data-testid="save-status">
        {status === 'pending' || status === 'saving'
          ? t('shell.saving')
          : status === 'error'
            ? t('shell.saveFailed')
            : showSaved
              ? t('shell.saved')
              : ''}
      </span>
      {status === 'error' && (
        <Button
          tone="secondary"
          size="sm"
          className="save-retry"
          data-testid="save-retry"
          onClick={() => { void vault.flush() }}
        >
          {t('common.retry')}
        </Button>
      )}
    </>
  )
})

const Workspace = observer(function Workspace() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const git = useService(GitService)
  const settings = useService(SettingsService)
  const layout = useService(LayoutService)
  const note = vault.active
  useEffect(() => {
    if (vault.phase !== 'ready') return
    void git.refresh()
    git.ensureAutoSync()
    git.ensureAutoGit()
    return () => {
      git.stopAutoSync()
      git.stopAutoGit()
    }
  }, [git, vault.phase, vault.fs, settings.form.gitEnabled, settings.form.autoSyncMinutes, settings.form.autoGitEnabled, settings.form.autoGitIdleSeconds, settings.form.autoGitBlurSeconds])
  useEffect(() => {
    const onBlur = () => { git.noteBlur() }
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('blur', onBlur) }
  }, [git])
  return (
    <div className="shell" data-testid="vault-surface">
      <UpdateBanner />
      <div className="workspace">
        {!layout.sidebarCollapsed && (
          <>
            <aside className="rail" data-testid="sidebar" style={{ width: layout.sidebarWidth }}>
              <RailChrome />
              <div className="rail-scroll">
                <Rail />
              </div>
            </aside>
            <ResizeHandle column="sidebar" label={t('shell.resizeSidebar')} onDoubleToggle={() => layout.toggleSidebar()} />
          </>
        )}
        <section className="note-list-col" style={{ width: layout.noteListWidth }} aria-label={t('shell.notes')}>
          <NoteList leading={layout.sidebarCollapsed ? <CollapsedChrome /> : undefined} />
        </section>
        <ResizeHandle column="noteList" label={t('shell.resizeNotes')} />
        <main className="stage">
          <TabStrip />
          <div className="stage-scroll">
            {note ? (
              <>
                <div className="stage-head">
                  <input
                    className="note-title"
                    data-testid="note-title"
                    value={note.title}
                    onChange={(event) => vault.updateTitle(event.target.value)}
                    onBlur={() => { void vault.commitHeadingRename() }}
                  />
                  <SaveStatus />
                </div>
                <NoteEditor key={note.id} />
              </>
            ) : (
              <EmptyState
                icon={Notebook}
                title={t('shell.noNoteTitle')}
                body={t('shell.noNoteBody')}
                actionLabel={t('shell.newNote')}
                actionTestId="stage-new-note"
                onAction={() => vault.createNote()}
                className="sd-empty-state-stage"
                testId="stage-empty"
              />
            )}
            {vault.error && <p className="error" data-testid="vault-error" role="alert">{vault.error}</p>}
            {vault.broad && <p className="meta">{t('chooser.broadRoot')}</p>}
          </div>
        </main>
        {layout.rightPanelCollapsed ? (
          <PanelRail />
        ) : (
          <>
            <ResizeHandle
              column="rightPanel"
              edge="start"
              label={t('shell.resizePanel')}
              onDoubleToggle={() => layout.toggleRightPanel()}
            />
            <aside className="panel" style={{ width: layout.rightPanelWidth }}>
              <RightPanel />
            </aside>
          </>
        )}
      </div>
      <QuickOpen />
      <SearchPanel />
      <StatusBar />
    </div>
  )
})

const App = observer(function App() {
  const vault = useService(VaultService)
  // The palette mounts above both phases so Mod+K works from the chooser too;
  // manifest enabledWhen conditions gate what is runnable there.
  return (
    <TooltipProvider>
      {vault.phase === 'chooser' ? <Chooser /> : <Workspace />}
      <CommandPalette />
      <SettingsPage />
    </TooltipProvider>
  )
})

export { App }
