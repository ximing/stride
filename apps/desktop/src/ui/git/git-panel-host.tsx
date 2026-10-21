import { observer, useService } from '@rabjs/react'
import { useEffect } from 'react'
import { DEDICATED_ERROR } from '@stride/core'
import { GitService } from '../../services/git/git.service'
import { GitPanelView } from './git-panel'

export const GitPanel = observer(function GitPanel() {
  const git = useService(GitService)
  useEffect(() => {
    void git.refresh()
  }, [git])
  const error = git.output
    && git.output !== 'Git is not available in the browser'
    && git.output !== 'Git is turned off.'
    && git.output !== DEDICATED_ERROR
    ? git.output
    : ''
  return (
    <GitPanelView
      surface={git.surface}
      branch={git.branch}
      changes={git.changes}
      selected={git.selected}
      diff={git.diff}
      message={git.message}
      ahead={git.ahead}
      behind={git.behind}
      suggesting={git.suggesting}
      notice={git.surface === 'blocked' ? DEDICATED_ERROR : git.notice}
      browserNeedsInit={git.hasVault && !git.isRepo}
      error={error}
      onToggle={(path) => git.toggle(path)}
      onMessage={(value) => git.setMessage(value)}
      onOpenFileDiff={(path) => { void git.openDiff(path) }}
      onCommit={(paths) => { void git.commitSelected(paths) }}
      onSuggest={() => { void git.suggestMessage() }}
      onInit={() => { void git.init() }}
      remote={git.remote}
      onRemote={(value) => git.setRemote(value)}
      onAddRemote={() => { void git.addRemote() }}
      onPull={() => { void git.pull() }}
      onPush={() => { void git.push() }}
      historyEntries={git.historyEntries}
      historyText={git.historyText}
      onLoadHistory={() => { void git.loadHistory() }}
      onShowHistory={(rev) => { void git.showHistory(rev) }}
      onRestoreHistory={() => { void git.restoreHistory() }}
      conflicts={git.conflicts}
      onKeepSide={(path, side) => { void git.keepSide(path, side) }}
      onRetryError={() => { void git.refresh() }}
      onCommitOpenChange={(open) => {
        if (!open) git.abortSuggest()
      }}
    />
  )
})
