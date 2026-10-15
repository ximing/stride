import { GitBranch, House, MagnifyingGlass, Sparkle } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { syncState } from '@stride/core'
import type { GitSurface, SyncState } from '@stride/core'
import { LayoutService } from '../services/layout.service'
import { GitService } from '../services/panels.service'
import { VaultService } from '../services/vault.service'
import { APP_VERSION } from '../version'
import { Mark } from './icon'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

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
        <button type="button" className="git-status-badge" data-testid="git-status-badge">{gitBadge(git.surface, state)}</button>
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
  return (
    <footer className="statusbar" data-testid="statusbar">
      <span className="statusbar-item">
        <Mark icon={House} size={13} />
        {vault.currentVaultLabel}
      </span>
      {git.branch ? (
        <span className="statusbar-item" data-testid="statusbar-branch">
          <Mark icon={GitBranch} size={13} />
          {git.branch}
        </span>
      ) : null}
      <GitStatusBadge />
      {vault.indexPhase === 'error' ? (
        <button
          type="button"
          className="statusbar-item statusbar-action statusbar-index-error"
          data-testid="index-status"
          title="索引失败,点击重建"
          onClick={() => vault.retryIndex()}
        >
          <Mark icon={MagnifyingGlass} size={13} />
          {indexStatusLabel(vault.indexPhase, vault.indexDone, vault.indexTotal)}
          <span data-testid="index-retry">重试</span>
        </button>
      ) : (
        <span className="statusbar-item" data-testid="index-status">
          <Mark icon={MagnifyingGlass} size={13} />
          {indexStatusLabel(vault.indexPhase, vault.indexDone, vault.indexTotal)}
        </span>
      )}
      <span className="statusbar-spacer" />
      <button
        type="button"
        className="statusbar-item statusbar-action"
        data-testid="statusbar-ai"
        onClick={() => layout.setRightPanelTab('chat')}
      >
        <Mark icon={Sparkle} size={13} />
        Ask AI
      </button>
      <span className="statusbar-item statusbar-version" data-testid="statusbar-version">v{APP_VERSION}</span>
    </footer>
  )
})
