import { observer, useService } from '@rabjs/react'
import { BookOpen, FolderOpen, FolderPlus, GitBranch, Notebook } from 'lucide-react'
import { useEffect } from 'react'
import { NoteEditor } from './editor'
import { LayoutService } from './services/layout/layout.service'
import { GitService } from './services/git/git.service'
import { SettingsService } from './services/settings/settings.service'
import { VaultService } from './services/vault/vault.service'
import { Button } from './ui/primitives/button'
import { CommandPalette } from './ui/overlays/command-palette'
import { EmptyState } from './ui/primitives/empty-state'
import { Mark } from './ui/primitives/icon'
import { Input } from './ui/primitives/input'
import { NoteList } from './ui/note-list/note-list'
import { QuickOpen } from './ui/overlays/quick-open'
import { ResizeHandle } from './ui/shell/resize-handle'
import { PanelRail, RightPanel } from './ui/panels/right-panel'
import { SearchPanel } from './ui/overlays/search-panel'
import { SettingsPage } from './ui/settings/settings-page'
import { Rail } from './ui/shell/sidebar'
import { StatusBar } from './ui/shell/status-bar'
import { TabStrip } from './ui/shell/tab-strip'
import { TooltipProvider } from './ui/primitives/tooltip'
import { TopBar } from './ui/shell/topbar'
import { UpdateBanner } from './ui/shell/update-banner'

// Re-exports keep existing test imports (`from '../app'`) stable.
export { Rail } from './ui/shell/sidebar'
export { GitStatusBadge } from './ui/shell/status-bar'
export { UpdateBanner } from './ui/shell/update-banner'

const Chooser = observer(function Chooser() {
  const vault = useService(VaultService)
  const git = useService(GitService)
  return (
    <section className="chooser" data-testid="vault-surface">
      <div className="chooser-panel">
        <div className="chooser-copy">
          <div className="chooser-brand">
            <span className="chooser-brand-mark" aria-hidden="true">
              <Mark icon={Notebook} size={22} />
            </span>
            <h1>Stride</h1>
          </div>
          <p className="chooser-lead">A local-first workspace for your notes.</p>
          <p className="chooser-description">
            Keep rich-text notes in a folder you control. Use Git for history and sync when you need it—no account required.
          </p>
        </div>
        <form
          className="chooser-form"
          onSubmit={(event) => {
            event.preventDefault()
          }}
        >
          <div className="chooser-start">
            <div className="chooser-section-label">Start a workspace</div>
            <div className="chooser-actions">
              <Button
                tone="primary"
                size="lg"
                icon={<Mark icon={FolderPlus} size={16} />}
                data-testid="new-vault"
                onClick={() => void vault.createNewVault()}
              >
                New vault
              </Button>
              <Button
                tone="secondary"
                size="lg"
                icon={<Mark icon={FolderOpen} size={16} />}
                data-testid="open-vault"
                onClick={() => void vault.openFromDraft()}
              >
                Open vault
              </Button>
              <Button
                tone="quiet"
                size="lg"
                icon={<Mark icon={BookOpen} size={16} />}
                data-testid="clone-sample"
                onClick={() => void vault.cloneSampleVault()}
              >
                Clone sample
              </Button>
            </div>
          </div>
          <div className="chooser-git">
            <div className="chooser-git-row">
              <Input
                label="Git repository URL"
                className="chooser-git-input"
                data-testid="git-clone-url"
                placeholder="https://github.com/you/notes.git"
                value={git.cloneUrl}
                onChange={(event) => git.setCloneUrl(event.target.value)}
                spellCheck={false}
              />
              <Button
                tone="secondary"
                size="md"
                icon={<Mark icon={GitBranch} size={16} />}
                data-testid="git-clone"
                disabled={git.surface === 'unavailable'}
                onClick={() => {
                  if (git.surface === 'unavailable') return
                  void git.cloneRemote()
                }}
              >
                Clone
              </Button>
            </div>
            {git.surface === 'unavailable' && (
              <p className="chooser-hint" data-testid="git-clone-unavailable">git clone needs the desktop app</p>
            )}
            {git.cloneError && <p className="error chooser-error" data-testid="git-clone-error" role="alert">{git.cloneError}</p>}
          </div>
          {vault.error && <p className="error chooser-error" data-testid="vault-error" role="alert">{vault.error}</p>}
        </form>
      </div>
    </section>
  )
})

const Workspace = observer(function Workspace() {
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
      <TopBar />
      <div className="workspace">
        {!layout.sidebarCollapsed && (
          <>
            <aside className="rail" data-testid="sidebar" style={{ width: layout.sidebarWidth }}>
              <Rail />
            </aside>
            <ResizeHandle column="sidebar" label="Resize sidebar" onDoubleToggle={() => layout.toggleSidebar()} />
          </>
        )}
        <section className="note-list-col" style={{ width: layout.noteListWidth }} aria-label="Notes">
          <NoteList />
        </section>
        <ResizeHandle column="noteList" label="Resize note list" />
        <main className="stage">
          <TabStrip />
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
                <span
                  className={vault.saveStatus === 'error' ? 'save-status is-error' : 'save-status'}
                  data-testid="save-status"
                >
                  {vault.saveStatus === 'pending' || vault.saveStatus === 'saving'
                    ? '保存中'
                    : vault.saveStatus === 'saved'
                      ? '已保存'
                      : vault.saveStatus === 'error'
                        ? '保存失败'
                        : ''}
                </span>
                {vault.saveStatus === 'error' && (
                  <Button
                    tone="secondary"
                    size="sm"
                    className="save-retry"
                    data-testid="save-retry"
                    onClick={() => { void vault.flush() }}
                  >
                    重试
                  </Button>
                )}
                <label className="rename-toggle">
                  <input
                    type="checkbox"
                    data-testid="rename-from-heading"
                    checked={vault.renameFromHeading}
                    onChange={(event) => { void vault.setRenameFromHeading(event.target.checked) }}
                  />
                  Rename from heading
                </label>
              </div>
              <NoteEditor key={note.id} />
            </>
          ) : (
            <EmptyState
              icon={Notebook}
              title="No note selected"
              body="Pick a note from the list, or create a new one."
              actionLabel="New note"
              actionTestId="stage-new-note"
              onAction={() => vault.createNote()}
              className="sd-empty-state-stage"
              testId="stage-empty"
            />
          )}
          {vault.error && <p className="error" data-testid="vault-error" role="alert">{vault.error}</p>}
          {vault.broad && <p className="meta">This folder is a broad personal root. Git init stays off unless it is already a dedicated vault.</p>}
        </main>
        {layout.rightPanelCollapsed ? (
          <PanelRail />
        ) : (
          <>
            <ResizeHandle
              column="rightPanel"
              edge="start"
              label="Resize panel"
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
