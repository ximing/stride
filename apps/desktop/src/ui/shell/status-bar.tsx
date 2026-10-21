import { observer, useService } from '@rabjs/react'
import { syncState } from '@stride/core'
import type { GitSurface, SyncState } from '@stride/core'
import { GitBranch, Home, RefreshCw, Search, Settings, Sparkles } from 'lucide-react'
import { LayoutService } from '../../services/layout/layout.service'
import { GitService } from '../../services/git/git.service'
import { SettingsPageService } from '../../services/settings/settings-page.service'
import { UpdateCheckService } from '../../services/update/update-check'
import { VaultService } from '../../services/vault/vault.service'
import { APP_VERSION } from '../../version'
import { Button } from '../primitives/button'
import { Mark } from '../primitives/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/popover'

function gitSyncFailed(surface: GitSurface, output: string): boolean {
  if (surface !== 'ready') return false
  if (output === 'Git is not available in the browser') return false
  if (output === 'Git is turned off.') return false
  return output.length > 0
}

function gitBadge(surface: GitSurface, state: SyncState): string {
  if (surface === 'unavailable') return 'Git unavailable'
  if (surface === 'disabled') return 'Git off'
  if (surface === 'blocked') return 'Git blocked'
  if (surface === 'needs-init') return 'Not a repo'
  if (state === 'pull_required') return 'pull required'
  return state
}

export const GitStatusBadge = observer(function GitStatusBadge() {
  const git = useService(GitService)
  const state = syncState({
    busy: git.busy,
    conflict: git.conflicts.length > 0,
    behind: git.behind,
    error: gitSyncFailed(git.surface, git.output),
  })
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button tone="quiet" size="sm" className="git-status-badge" data-testid="git-status-badge">
          {gitBadge(git.surface, state)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="git-sync-popover" side="top" data-testid="git-sync-popover">
        <p>{git.branch}</p>
        <p>ahead {git.ahead}</p>
        <p>behind {git.behind}</p>
        {state === 'error' ? <p>{git.output}</p> : null}
      </PopoverContent>
    </Popover>
  )
})

function indexStatusLabel(phase: VaultService['indexPhase'], done: number, total: number): string {
  if (phase === 'rebuilding') return `索引 ${done}/${total}`
  if (phase === 'ready') return '索引就绪'
  if (phase === 'error') return '索引失败'
  return ''
}

export const StatusBar = observer(function StatusBar() {
  const vault = useService(VaultService)
  const git = useService(GitService)
  const layout = useService(LayoutService)
  const settingsPage = useService(SettingsPageService)
  const updateCheck = useService(UpdateCheckService)
  return (
    <footer className="statusbar" data-testid="statusbar">
      <span className="statusbar-item">
        <Mark icon={Home} size={14} />
        {vault.currentVaultLabel}
      </span>
      {git.branch ? (
        <span className="statusbar-item" data-testid="statusbar-branch">
          <Mark icon={GitBranch} size={14} />
          {git.branch}
        </span>
      ) : null}
      <GitStatusBadge />
      {vault.indexPhase === 'error' ? (
        <Button
          tone="quiet"
          size="sm"
          className="statusbar-item statusbar-action statusbar-index-error"
          data-testid="index-status"
          title="索引失败,点击重建"
          icon={<Mark icon={Search} size={14} />}
          onClick={() => vault.retryIndex()}
        >
          {indexStatusLabel(vault.indexPhase, vault.indexDone, vault.indexTotal)}
          <span data-testid="index-retry">重试</span>
        </Button>
      ) : (
        <span className="statusbar-item" data-testid="index-status">
          <Mark icon={Search} size={14} />
          {indexStatusLabel(vault.indexPhase, vault.indexDone, vault.indexTotal)}
        </span>
      )}
      <span className="statusbar-spacer" />
      {updateCheck.supported ? (
        <Button
          tone="quiet"
          size="sm"
          className="statusbar-item statusbar-action"
          data-testid="statusbar-update-check"
          disabled={updateCheck.feedback === 'checking'}
          title="Check for updates"
          icon={<Mark icon={RefreshCw} size={14} />}
          onClick={() => void updateCheck.manualCheck()}
        >
          {updateCheck.feedback === 'checking' ? '检查中…' : '检查更新'}
        </Button>
      ) : null}
      {updateCheck.feedbackText ? (
        <span className="statusbar-item" data-testid="statusbar-update-feedback">
          {updateCheck.feedbackText}
        </span>
      ) : null}
      <Button
        tone="quiet"
        size="sm"
        className="statusbar-item statusbar-action"
        data-testid="statusbar-ai"
        icon={<Mark icon={Sparkles} size={14} />}
        onClick={() => layout.setRightPanelTab('chat')}
      >
        Ask AI
      </Button>
      <Button
        tone="quiet"
        size="sm"
        className="statusbar-item statusbar-action"
        data-testid="statusbar-settings"
        aria-label="Settings"
        title="Settings"
        icon={<Mark icon={Settings} size={14} />}
        onClick={() => settingsPage.show()}
      >
        Settings
      </Button>
      <span className="statusbar-item statusbar-version" data-testid="statusbar-version">v{APP_VERSION}</span>
    </footer>
  )
})
