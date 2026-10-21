import { observer, useService } from '@rabjs/react'
import { syncState } from '@stride/core'
import type { GitSurface, SyncState } from '@stride/core'
import { GitBranch, Home, RefreshCw, Search, Settings, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { t } from '../../i18n'
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
  if (surface === 'unavailable') return t('git.badge.unavailable')
  if (surface === 'disabled') return t('git.badge.disabled')
  if (surface === 'blocked') return t('git.badge.blocked')
  if (surface === 'needs-init') return t('git.badge.needsInit')
  if (state === 'pull_required') return t('git.badge.pullRequired')
  if (state === 'idle') return t('git.badge.idle')
  if (state === 'syncing') return t('git.badge.syncing')
  if (state === 'conflict') return t('git.badge.conflict')
  if (state === 'error') return t('git.badge.error')
  return state
}

export const GitStatusBadge = observer(function GitStatusBadge() {
  const { t: translate } = useTranslation()
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
        <p>{translate('git.ahead', { count: git.ahead })}</p>
        <p>{translate('git.behind', { count: git.behind })}</p>
        {state === 'error' ? <p>{git.output}</p> : null}
      </PopoverContent>
    </Popover>
  )
})

function indexStatusLabel(phase: VaultService['indexPhase'], done: number, total: number): string {
  if (phase === 'rebuilding') return t('shell.indexProgress', { done, total })
  if (phase === 'ready') return t('shell.indexReady')
  if (phase === 'error') return t('shell.indexFailed')
  return ''
}

export const StatusBar = observer(function StatusBar() {
  const { t: translate } = useTranslation()
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
          title={translate('shell.indexFailedTitle')}
          icon={<Mark icon={Search} size={14} />}
          onClick={() => vault.retryIndex()}
        >
          {indexStatusLabel(vault.indexPhase, vault.indexDone, vault.indexTotal)}
          <span data-testid="index-retry">{translate('common.retry')}</span>
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
          title={translate('shell.checkUpdates')}
          icon={<Mark icon={RefreshCw} size={14} />}
          onClick={() => void updateCheck.manualCheck()}
        >
          {updateCheck.feedback === 'checking' ? translate('shell.checking') : translate('shell.checkUpdates')}
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
        {translate('shell.askAi')}
      </Button>
      <Button
        tone="quiet"
        size="sm"
        className="statusbar-item statusbar-action"
        data-testid="statusbar-settings"
        aria-label={translate('shell.settings')}
        title={translate('shell.settings')}
        icon={<Mark icon={Settings} size={14} />}
        onClick={() => settingsPage.show()}
      >
        {translate('shell.settings')}
      </Button>
      <span className="statusbar-item statusbar-version" data-testid="statusbar-version">v{APP_VERSION}</span>
    </footer>
  )
})
