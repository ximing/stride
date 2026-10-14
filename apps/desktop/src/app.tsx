import type { Icon } from '@phosphor-icons/react'
import { Bookmark } from '@phosphor-icons/react/Bookmark'
import { Briefcase } from '@phosphor-icons/react/Briefcase'
import { Calendar } from '@phosphor-icons/react/Calendar'
import { Folder } from '@phosphor-icons/react/Folder'
import { Note } from '@phosphor-icons/react/Note'
import { Star } from '@phosphor-icons/react/Star'
import { Tag } from '@phosphor-icons/react/Tag'
import { User } from '@phosphor-icons/react/User'
import { observer, useService } from '@rabjs/react'
import { useEffect, useState } from 'react'
import { DEDICATED_ERROR, LLM_PROVIDERS, catalogBaseUrl, catalogModelSuggestions, syncState } from '@stride/core'
import type { GitSurface, SyncState } from '@stride/core'
import type { StrideNote } from '@stride/core/note'
import { typeSidebarLabel } from '../../../packages/core/src/types'
import { NoteEditor } from './editor'
import { ChatService, GitService, SettingsService, UpdateService } from './services/panels.service'
import { VaultService } from './services/vault.service'
import { GitPanelView } from './ui/git-panel'
import { Mark } from './ui/icon'
import { FolderTree } from './ui/folder-tree'
import { PropertiesPanel } from './ui/properties-panel'
import { QuickOpen } from './ui/quick-open'
import { SearchPanel } from './ui/search-panel'
import { TocPanel } from './ui/toc-panel'
import { ChatMarkdown } from './ui/chat-markdown'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const TYPE_ICONS: Record<string, Icon> = {
  note: Note,
  briefcase: Briefcase,
  user: User,
  folder: Folder,
  star: Star,
  tag: Tag,
  calendar: Calendar,
  bookmark: Bookmark,
}

const TYPE_COLORS = new Set(['gray', 'blue', 'teal', 'green', 'orange', 'purple', 'red', 'pink', 'yellow'])

function propertyText(value: StrideNote['properties'][string] | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? ''
  return ''
}

function indexStatusLabel(phase: VaultService['indexPhase'], done: number, total: number): string {
  if (phase === 'rebuilding') return `索引 ${done}/${total}`
  if (phase === 'ready') return '索引就绪'
  if (phase === 'error') return '索引失败'
  return ''
}

function typeIconKey(note: StrideNote): string {
  const key = propertyText(note.properties._icon).trim().toLowerCase()
  return key in TYPE_ICONS ? key : 'note'
}

function typeColorKey(note: StrideNote): string {
  const key = propertyText(note.properties._color).trim().toLowerCase()
  return TYPE_COLORS.has(key) ? key : 'gray'
}

export const UpdateBanner = observer(function UpdateBanner() {
  const updates = useService(UpdateService)
  if (updates.phase === 'idle' && !updates.error) return null
  return (
    <div className="update-banner" data-testid="update-banner">
      {updates.phase === 'available' && <strong>Update available {updates.version}</strong>}
      {updates.phase === 'downloading' && <strong>Downloading update</strong>}
      {updates.phase === 'ready' && <strong>Update ready</strong>}
      {updates.phase === 'downloading' && (
        <div className="progress" aria-valuenow={Math.round(updates.progress * 100)}>
          <span style={{ width: `${Math.round(updates.progress * 100)}%` }} />
        </div>
      )}
      {updates.phase === 'available' && <button type="button" onClick={() => updates.download()}>Download</button>}
      {updates.phase === 'ready' && <button type="button" onClick={() => updates.confirm()}>Restart</button>}
      {updates.phase !== 'idle' && <button type="button" onClick={() => updates.dismiss()}>Dismiss</button>}
      {updates.error && <span className="error">{updates.error}</span>}
    </div>
  )
})

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
        {vault.error && <p className="error">{vault.error}</p>}
      </form>
    </section>
  )
})

export const Rail = observer(function Rail() {
  const vault = useService(VaultService)
  const typeDocs = vault.sidebarTypes
  const fallbackTypes = vault.typeDocuments.length === 0 ? [...vault.graph.byType.keys()] : []
  const showInstances = vault.active?.type === 'Type'
  return (
    <aside className="rail">
      <button type="button" data-testid="new-note" className="primary" onClick={() => vault.createNote()}>New note</button>
      <div className="group-label">Views</div>
      <button type="button" className={vault.listFilter === 'all' ? 'active' : ''} onClick={() => vault.setFilter('all')}>All</button>
      <button type="button" className={vault.listFilter === 'inbox' ? 'active' : ''} onClick={() => vault.setFilter('inbox')}>
        Inbox ({vault.inboxCount})
      </button>
      {vault.listFilter === 'inbox' && (
        <label className="advance-inbox">
          <input
            type="checkbox"
            data-testid="advance-inbox"
            checked={vault.advanceInbox}
            onChange={(event) => { void vault.setAdvanceInbox(event.target.checked) }}
          />
          Advance after organizing
        </label>
      )}
      <div className="group-label">Types</div>
      {typeDocs.map((note) => {
        const icon = typeIconKey(note)
        const color = typeColorKey(note)
        const collapsed = vault.collapsedTypes.includes(note.title)
        return (
          <div className="type-row" key={note.id}>
            <button
              type="button"
              data-testid="type-link"
              data-type={note.title}
              data-icon={icon}
              className={vault.listFilter === note.title ? 'active' : ''}
              onClick={() => {
                vault.setFilter(note.title)
                vault.select(note.id)
              }}
            >
              <span className={`type-dot type-dot-${color}`} />
              <span className="type-icon"><Mark icon={TYPE_ICONS[icon] ?? Note} size={16} /></span>
              <span className="type-label">{typeSidebarLabel(note)}</span>
            </button>
            {collapsed ? null : (
              <button
                type="button"
                className="type-add"
                data-testid="type-new-instance"
                data-type={note.title}
                aria-label={`New ${note.title}`}
                onClick={() => vault.createInstance(note.title)}
              >
                +
              </button>
            )}
            <button
              type="button"
              className="type-collapse"
              data-testid="type-collapse"
              data-type={note.title}
              aria-expanded={!collapsed}
              aria-label={collapsed ? `Expand ${note.title}` : `Collapse ${note.title}`}
              onClick={() => vault.toggleTypeCollapsed(note.title)}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          </div>
        )
      })}
      <button type="button" data-testid="new-type" onClick={() => vault.createType()}>New type</button>
      {showInstances && (
        <div className="type-instances" data-testid="type-instances">
          <div className="group-label">Instances</div>
          {vault.typeInstances.length === 0 && <p>No instances yet.</p>}
          {vault.typeInstances.map((note) => (
            <button
              key={note.id}
              type="button"
              data-testid="instance-link"
              className={vault.activeId === note.id ? 'active' : ''}
              onClick={() => vault.select(note.id)}
            >
              {note.title}
            </button>
          ))}
        </div>
      )}
      {fallbackTypes.map((type) => (
        <button key={type} type="button" className={vault.listFilter === type ? 'active' : ''} onClick={() => vault.setFilter(type)}>
          {type}
        </button>
      ))}
      <div className="group-label">Notes</div>
      <FolderTree />
    </aside>
  )
})

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

const GitPanel = observer(function GitPanel() {
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
      onCommitOpenChange={(open) => {
        if (!open) git.abortSuggest()
      }}
    />
  )
})

const ChatPanel = observer(function ChatPanel() {
  const chat = useService(ChatService)
  const vault = useService(VaultService)
  const session = chat.sessions.find((item) => item.id === chat.activeId) ?? chat.sessions[0]
  return (
    <div data-testid="chat-panel">
      <h2>Agent</h2>
      <div className="chat-tabs" data-testid="chat-tabs">
        {chat.sessions.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={item.id === chat.activeId}
            onClick={() => chat.select(item.id)}
          >
            {item.title}
          </button>
        ))}
        <button type="button" data-testid="chat-new" onClick={() => chat.newSession()}>New</button>
      </div>
      <div className="chat-messages" data-testid="chat-messages">
        {session?.messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className="chat-message">
            <strong>{message.role}</strong>
            {message.role === 'assistant' && message.thinking ? (
              <details className="chat-thinking" data-testid="chat-thinking">
                <summary>思考</summary>
                <ChatMarkdown text={message.thinking} />
              </details>
            ) : null}
            {message.role === 'assistant' && message.tools.map((tool) => (
              <div key={tool.id} className={tool.isError ? 'chat-tool is-error' : 'chat-tool'} data-testid="chat-tool">
                <span data-testid="chat-tool-name">{tool.name}</span>
                <span data-testid="chat-tool-args">{tool.argsSummary}</span>
                {tool.pending ? <span>running</span> : <span data-testid="chat-tool-result">{tool.resultSummary}</span>}
                {typeof tool.durationMs === 'number' ? <span data-testid="chat-tool-duration">{tool.durationMs} ms</span> : null}
              </div>
            ))}
            {message.role === 'assistant' ? <ChatMarkdown text={message.text} /> : <p>{message.text}</p>}
          </div>
        ))}
      </div>
      {chat.error && <p className="error">{chat.error}</p>}
      <div className="chat-compose">
        <div className="chat-mode">
          <button type="button" data-testid="chat-mode-safe" aria-pressed={vault.agentMode === 'safe'} onClick={() => { void vault.setAgentMode('safe') }}>Safe</button>
          <button type="button" data-testid="chat-mode-power" aria-pressed={vault.agentMode === 'power'} onClick={() => { void vault.setAgentMode('power') }}>Power</button>
        </div>
        <textarea
          data-testid="chat-draft"
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          placeholder="Ask about the open note"
        />
        <button className="primary" type="button" data-testid="chat-send" disabled={chat.running} onClick={() => { void chat.send() }}>Send</button>
        <button type="button" data-testid="chat-abort" disabled={!chat.running} onClick={() => chat.abort()}>Stop</button>
      </div>
    </div>
  )
})

const SettingsPanel = observer(function SettingsPanel() {
  const settings = useService(SettingsService)
  const updates = useService(UpdateService)
  const selected = settings.form.llmConfigs.find((config) => config.id === settings.selectedLlmId)
  return (
    <div>
      <h2>Settings</h2>
      <label className="field"><span>Embedding endpoint</span>
        <input value={settings.form.embedding.endpoint} onChange={(event) => settings.patchEmbedding({ endpoint: event.target.value })} />
      </label>
      <label className="field"><span>Embedding model</span>
        <input value={settings.form.embedding.model} onChange={(event) => settings.patchEmbedding({ model: event.target.value })} />
      </label>
      <label className="field"><span>Embedding dim</span>
        <input
          data-testid="embedding-dim"
          inputMode="numeric"
          value={settings.embeddingDimText}
          onChange={(event) => settings.setEmbeddingDim(event.target.value)}
        />
      </label>
      <label className="field"><span>Embedding key</span>
        <input
          type="password"
          value={settings.embeddingKey}
          placeholder={settings.form.embedding.keyMask}
          onChange={(event) => { settings.embeddingKey = event.target.value }}
        />
        {settings.form.embedding.keyMask ? <span className="meta">{settings.form.embedding.keyMask}</span> : null}
      </label>
      <div className="editor-tools">
        <button type="button" data-testid="embedding-test" onClick={() => { void settings.testEmbedding() }}>Test connection</button>
      </div>
      <p className="meta" data-testid="embedding-test-result">{settings.embeddingTestResult}</p>
      <label className="field"><span>LLM config</span>
        <select
          data-testid="llm-config"
          value={settings.selectedLlmId}
          onChange={(event) => { settings.selectedLlmId = event.target.value }}
        >
          {settings.form.llmConfigs.map((config) => (
            <option key={config.id} value={config.id}>{config.name || config.id}</option>
          ))}
        </select>
      </label>
      <div className="editor-tools">
        <button type="button" data-testid="llm-add" onClick={() => settings.addLlmConfig()}>Add</button>
        <button type="button" data-testid="llm-delete" onClick={() => settings.removeLlmConfig()}>Delete</button>
        <button type="button" data-testid="llm-default" onClick={() => settings.setDefaultLlmConfig()}>Default</button>
      </div>
      {selected && (
        <>
          <label className="field"><span>Name</span>
            <input data-testid="llm-name" value={selected.name} onChange={(event) => settings.patchLlmConfig({ name: event.target.value })} />
          </label>
          <label className="field"><span>Provider</span>
            <select data-testid="llm-provider" value={selected.provider} onChange={(event) => settings.patchLlmConfig({ provider: event.target.value })}>
              {LLM_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>Model</span>
            <input
              data-testid="llm-model"
              value={selected.model}
              list="llm-model-suggestions"
              onChange={(event) => settings.patchLlmConfig({ model: event.target.value })}
            />
            <datalist id="llm-model-suggestions">
              {catalogModelSuggestions(selected.provider).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label className="field"><span>Base URL</span>
            <input
              data-testid="llm-base-url"
              value={selected.baseUrl}
              placeholder={catalogBaseUrl(selected.provider)}
              onChange={(event) => settings.patchLlmConfig({ baseUrl: event.target.value })}
            />
          </label>
          <label className="field"><span>API key</span>
            <input
              data-testid="llm-key"
              type="password"
              value={settings.llmKeyDrafts[selected.id] ?? ''}
              placeholder={selected.keyMask}
              onChange={(event) => { settings.llmKeyDrafts = { ...settings.llmKeyDrafts, [selected.id]: event.target.value } }}
            />
          </label>
          <div className="editor-tools">
            <button type="button" data-testid="llm-test" onClick={() => { void settings.testSelectedLlm() }}>Test connection</button>
          </div>
          <p className="meta" data-testid="llm-test-result">{settings.llmTestResult}</p>
        </>
      )}
      <label className="field"><span>GitHub releases URL</span>
        <input value={settings.form.releasesUrl} onChange={(event) => settings.setReleasesUrl(event.target.value)} />
      </label>
      <label className="field"><span>Git enabled</span>
        <input
          type="checkbox"
          data-testid="git-enabled"
          checked={settings.form.gitEnabled}
          onChange={(event) => settings.setGitEnabled(event.target.checked)}
        />
      </label>
      <label className="field"><span>Auto sync (minutes)</span>
        <input
          type="number"
          min={0}
          data-testid="auto-sync-minutes"
          value={settings.form.autoSyncMinutes}
          onChange={(event) => settings.setAutoSyncMinutes(Number(event.target.value))}
        />
      </label>
      <div className="editor-tools">
        <button type="button" data-testid="settings-save" onClick={() => settings.save()}>Save settings</button>
        <button type="button" onClick={() => updates.check()}>Check for updates</button>
      </div>
      {settings.notice && <p className="meta">{settings.notice}</p>}
    </div>
  )
})

const VaultSwitcher = observer(function VaultSwitcher() {
  const vault = useService(VaultService)
  const [open, setOpen] = useState(false)
  return (
    <div className="vault-switcher">
      <button
        type="button"
        data-testid="vault-switcher"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {vault.currentVaultLabel}
      </button>
      {open && (
        <div className="vault-switcher-list" role="listbox">
          {vault.vaults.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              data-testid="vault-option"
              data-vault-id={entry.id}
              className={entry.id === vault.activeVaultId ? 'active' : ''}
              onClick={() => {
                setOpen(false)
                void vault.switchVault(entry.id)
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

const Workspace = observer(function Workspace() {
  const vault = useService(VaultService)
  const git = useService(GitService)
  const settings = useService(SettingsService)
  const note = vault.active
  useEffect(() => {
    if (vault.phase !== 'ready') return
    void git.refresh()
    git.ensureAutoSync()
    return () => { git.stopAutoSync() }
  }, [git, vault.phase, vault.fs, settings.form.gitEnabled, settings.form.autoSyncMinutes])
  return (
    <div className="shell" data-testid="vault-surface">
      <UpdateBanner />
      <header className="topbar">
        <div className="brand">
          <div className="wordmark">Stride</div>
          <VaultSwitcher />
        </div>
        <form className="search" onSubmit={(event) => { event.preventDefault(); void vault.runSearch() }}>
          <input data-testid="vault-search" value={vault.searchQuery} onChange={(event) => { vault.searchQuery = event.target.value }} placeholder="Search the vault" />
          <button type="submit" data-testid="run-search">Search</button>
          <button type="button" onClick={() => vault.clearSearch()}>Clear</button>
          <span className="search-mode" data-testid="search-mode">{vault.searchMode ? `Search mode ${vault.searchMode}` : ''}</span>
          {vault.searchDegraded ? <span data-testid="search-degraded">已降级为 BM25</span> : null}
          <span className="index-status" data-testid="index-status">{indexStatusLabel(vault.indexPhase, vault.indexDone, vault.indexTotal)}</span>
        </form>
        <button
          type="button"
          data-testid="toc-toggle"
          aria-pressed={vault.panel === 'toc'}
          onClick={() => vault.setPanel('toc')}
        >
          大纲
        </button>
        <button type="button" onClick={() => vault.setPanel('properties')}>Properties</button>
        <button type="button" onClick={() => vault.setPanel('git')}>Git</button>
        <button type="button" onClick={() => vault.setPanel('chat')}>Agent</button>
        <button type="button" onClick={() => vault.setPanel('settings')}>Settings</button>
      </header>
      <div className="workspace">
        <Rail />
        <main className="stage">
          {note ? (
            <>
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
              <label>
                <input
                  type="checkbox"
                  data-testid="rename-from-heading"
                  checked={vault.renameFromHeading}
                  onChange={(event) => { void vault.setRenameFromHeading(event.target.checked) }}
                />
                Rename from heading
              </label>
              <NoteEditor key={note.id} />
            </>
          ) : (
            <p className="empty-note">This vault has no notes yet.</p>
          )}
          {vault.error && <p className="error">{vault.error}</p>}
          {vault.broad && <p className="meta">This folder is a broad personal root. Git init stays off unless it is already a dedicated vault.</p>}
        </main>
        <aside className="panel">
          {vault.panel === 'properties' && <PropertiesPanel />}
          {vault.panel === 'toc' && <TocPanel />}
          {vault.panel === 'git' && <GitPanel />}
          {vault.panel === 'chat' && <ChatPanel />}
          {vault.panel === 'settings' && <SettingsPanel />}
        </aside>
      </div>
      <QuickOpen />
      <SearchPanel />
      <footer className="git-status">
        <GitStatusBadge />
      </footer>
    </div>
  )
})

const App = observer(function App() {
  const vault = useService(VaultService)
  if (vault.phase === 'chooser') return <Chooser />
  return <Workspace />
})

export { App }
