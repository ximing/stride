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
import { useState } from 'react'
import type { StrideNote } from '@stride/core/note'
import { typeSidebarLabel } from '../../../packages/core/src/types'
import { NoteEditor } from './editor'
import { ChatService, GitService, SettingsService, UpdateService } from './services/panels.service'
import { VaultService } from './services/vault.service'
import { Mark } from './ui/icon'
import { FolderTree } from './ui/folder-tree'
import { PropertiesPanel } from './ui/properties-panel'
import { TocPanel } from './ui/toc-panel'

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
        </div>
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

const GitPanel = observer(function GitPanel() {
  const git = useService(GitService)
  return (
    <div>
      <h2>Git</h2>
      <div className="editor-tools">
        <button type="button" onClick={() => git.init()}>Init</button>
        <button type="button" onClick={() => git.refresh()}>Status</button>
        <button type="button" onClick={() => git.pull()}>Pull</button>
        <button type="button" onClick={() => git.push()}>Push</button>
      </div>
      <label className="field"><span>Remote</span>
        <input value={git.remote} onChange={(event) => git.setRemote(event.target.value)} placeholder="https:// or a local path" />
      </label>
      <label className="field"><span>Commit</span>
        <input value={git.message} onChange={(event) => git.setMessage(event.target.value)} />
      </label>
      <button type="button" onClick={() => git.commit()}>Commit</button>
      <p className="meta">{git.status}</p>
      <p className="meta">{git.output}</p>
      {git.conflicts.map((id) => (
        <div key={id} className="editor-tools">
          <span>{id}</span>
          <button type="button" onClick={() => git.keepSide(id, 'ours')}>Keep ours</button>
          <button type="button" onClick={() => git.keepSide(id, 'theirs')}>Keep theirs</button>
        </div>
      ))}
      <pre className="diff">{git.diff}</pre>
      <pre className="history">{git.history}</pre>
    </div>
  )
})

const ChatPanel = observer(function ChatPanel() {
  const chat = useService(ChatService)
  return (
    <div>
      <h2>Agent</h2>
      <div className="history">
        {chat.lines.map((line, index) => (
          <p key={`${line.role}-${index}`}><strong>{line.role}</strong> {line.text}</p>
        ))}
      </div>
      {chat.error && <p className="error">{chat.error}</p>}
      <textarea value={chat.draft} onChange={(event) => chat.setDraft(event.target.value)} placeholder="Ask about the open note" />
      <button className="primary" type="button" onClick={() => chat.send()}>Send</button>
    </div>
  )
})

const SettingsPanel = observer(function SettingsPanel() {
  const settings = useService(SettingsService)
  const updates = useService(UpdateService)
  return (
    <div>
      <h2>Settings</h2>
      <label className="field"><span>Embedding endpoint</span>
        <input value={settings.form.embedding.endpoint} onChange={(event) => settings.patchEmbedding({ endpoint: event.target.value })} />
      </label>
      <label className="field"><span>Embedding model</span>
        <input value={settings.form.embedding.model} onChange={(event) => settings.patchEmbedding({ model: event.target.value })} />
      </label>
      <label className="field"><span>Embedding key</span>
        <input type="password" value={settings.embeddingKey} onChange={(event) => { settings.embeddingKey = event.target.value }} />
      </label>
      <label className="field"><span>LLM provider</span>
        <input value={settings.form.llm.provider} onChange={(event) => settings.patchLlm({ provider: event.target.value })} />
      </label>
      <label className="field"><span>LLM model</span>
        <input value={settings.form.llm.model} onChange={(event) => settings.patchLlm({ model: event.target.value })} />
      </label>
      <label className="field"><span>LLM base URL</span>
        <input value={settings.form.llm.baseUrl} onChange={(event) => settings.patchLlm({ baseUrl: event.target.value })} />
      </label>
      <label className="field"><span>LLM key</span>
        <input type="password" value={settings.llmKey} onChange={(event) => { settings.llmKey = event.target.value }} />
      </label>
      <label className="field"><span>GitHub releases URL</span>
        <input value={settings.form.releasesUrl} onChange={(event) => settings.setReleasesUrl(event.target.value)} />
      </label>
      <div className="editor-tools">
        <button type="button" onClick={() => settings.save()}>Save settings</button>
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
  const note = vault.active
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
    </div>
  )
})

const App = observer(function App() {
  const vault = useService(VaultService)
  if (vault.phase === 'chooser') return <Chooser />
  return <Workspace />
})

export { App }
