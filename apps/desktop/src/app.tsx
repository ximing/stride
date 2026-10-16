import { Notebook } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { useEffect } from 'react'
import { NoteEditor } from './editor'
import { LayoutService } from './services/layout.service'
import { GitService, SettingsService } from './services/panels.service'
import { VaultService } from './services/vault.service'
import { CommandPalette } from './ui/command-palette'
import { EmptyState } from './ui/empty-state'
import { NoteList } from './ui/note-list'
import { QuickOpen } from './ui/quick-open'
import { ResizeHandle } from './ui/resize-handle'
import { PanelRail, RightPanel } from './ui/right-panel'
import { SearchPanel } from './ui/search-panel'
import { SettingsPage } from './ui/settings/settings-page'
import { Rail } from './ui/sidebar'
import { StatusBar } from './ui/status-bar'
import { TabStrip } from './ui/tab-strip'
import { TooltipProvider } from './ui/tooltip'
import { TopBar } from './ui/topbar'
import { UpdateBanner } from './ui/update-banner'

// Re-exports keep existing test imports (`from '../app'`) stable.
export { Rail } from './ui/sidebar'
export { GitStatusBadge } from './ui/status-bar'
export { UpdateBanner } from './ui/update-banner'

const Chooser = observer(function Chooser() {
  const vault = useService(VaultService)
  const git = useService(GitService)
  return (
    <section className="chooser" data-testid="vault-surface">
      <div className="chooser-copy">
        <div className="eyebrow">Local first</div>
        <h1>Stride</h1>
        <p>A folder of rich-text notes. Git moves them. Nothing here needs an account.</p>
      </div>
      <form
        className="chooser-form"
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        <p className="chooser-lead">Welcome. Start an empty vault, open a folder, or clone the sample notes.</p>
        <div className="chooser-actions">
          <button className="primary" type="button" data-testid="new-vault" onClick={() => void vault.createNewVault()}>
            New vault
          </button>
          <button className="primary" type="button" data-testid="open-vault" onClick={() => void vault.openFromDraft()}>
            Open vault
          </button>
          <button className="primary" type="button" data-testid="clone-sample" onClick={() => void vault.cloneSampleVault()}>
            Clone sample
          </button>
          <input
            data-testid="git-clone-url"
            value={git.cloneUrl}
            onChange={(event) => git.setCloneUrl(event.target.value)}
          />
          <button
            className="primary"
            type="button"
            data-testid="git-clone"
            disabled={git.surface === 'unavailable'}
            onClick={() => {
              if (git.surface === 'unavailable') return
              void git.cloneRemote()
            }}
          >
            Clone
          </button>
        </div>
        {git.surface === 'unavailable' && (
          <p data-testid="git-clone-unavailable">git clone needs the desktop app</p>
        )}
        {git.cloneError && <p className="error" data-testid="git-clone-error">{git.cloneError}</p>}
        {vault.error && <p className="error" data-testid="vault-error" role="alert">{vault.error}</p>}
      </form>
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
                  <button
                    type="button"
                    className="save-retry"
                    data-testid="save-retry"
                    onClick={() => { void vault.flush() }}
                  >
                    重试
                  </button>
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
