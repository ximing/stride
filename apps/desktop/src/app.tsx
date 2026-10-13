import { observer, useService } from '@rabjs/react'
import { useState } from 'react'
import { relationsOf } from '@stride/core/graph'
import { NoteEditor } from './editor'
import { ChatService, GitService, SettingsService, UpdateService } from './services/panels.service'
import { VaultService } from './services/vault.service'

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
          void vault.openFromDraft()
        }}
      >
        <label>
          <span>Vault folder</span>
          <input
            data-testid="vault-path"
            value={vault.pathDraft}
            onChange={(event) => vault.setPathDraft(event.target.value)}
            placeholder="/path/to/vault"
          />
        </label>
        <div className="chooser-actions">
          <button className="primary" type="submit" data-testid="open-vault">Open vault</button>
          <button className="primary" type="button" data-testid="new-vault" onClick={() => void vault.createNewVault()}>
            New vault
          </button>
        </div>
        {vault.error && <p className="error">{vault.error}</p>}
      </form>
    </section>
  )
})

const Rail = observer(function Rail() {
  const vault = useService(VaultService)
  const typeDocs = vault.typeDocuments
  const fallbackTypes = typeDocs.length === 0 ? [...vault.graph.byType.keys()] : []
  return (
    <aside className="rail">
      <button type="button" data-testid="new-note" className="primary" onClick={() => vault.createNote()}>New note</button>
      <div className="group-label">Views</div>
      <button type="button" className={vault.listFilter === 'all' ? 'active' : ''} onClick={() => vault.setFilter('all')}>All</button>
      <button type="button" className={vault.listFilter === 'inbox' ? 'active' : ''} onClick={() => vault.setFilter('inbox')}>
        Inbox ({vault.inboxCount})
      </button>
      <div className="group-label">Types</div>
      {typeDocs.map((note) => (
        <button
          key={note.id}
          type="button"
          data-testid="type-link"
          data-type={note.title}
          className={vault.listFilter === note.title ? 'active' : ''}
          onClick={() => vault.setFilter(note.title)}
        >
          {note.title}
        </button>
      ))}
      {fallbackTypes.map((type) => (
        <button key={type} type="button" className={vault.listFilter === type ? 'active' : ''} onClick={() => vault.setFilter(type)}>
          {type}
        </button>
      ))}
      <div className="group-label">Notes</div>
      {vault.visibleNotes.map((note) => (
        <button
          key={note.id}
          type="button"
          data-testid="note-link"
          className={vault.activeId === note.id ? 'active' : ''}
          onClick={() => vault.select(note.id)}
        >
          {note.title}
        </button>
      ))}
    </aside>
  )
})

const Properties = observer(function Properties() {
  const vault = useService(VaultService)
  const note = vault.active
  if (!note) return <p className="empty-note">Select a note.</p>
  const relations = relationsOf(vault.graph, note.id)
  return (
    <div>
      <h2>Properties</h2>
      <label className="field"><span>Type</span>
        <input value={note.type} onChange={(event) => vault.updateType(event.target.value)} />
      </label>
      {['status', 'date', 'url', 'belongs_to', 'related_to'].map((field) => (
        <label className="field" key={field}>
          <span>{field}</span>
          <input value={vault.propertyText(field)} onChange={(event) => vault.updateProperty(field, event.target.value)} />
        </label>
      ))}
      <CustomProperty />
      <h2>Relationships</h2>
      {relations.shown.length === 0 && <p className="meta">No relationships yet.</p>}
      {relations.shown.map((link) => (
        <p key={`${link.field}-${link.targetId}-${link.derived}`} className="meta">
          {link.derived ? `${link.field} (derived)` : link.field}: {link.label}
        </p>
      ))}
      <h2>Backlinks</h2>
      {relations.backlinks.length === 0 && <p className="meta">No backlinks.</p>}
      {relations.backlinks.map((link) => (
        <button key={`${link.sourceId}-${link.via}`} type="button" onClick={() => vault.select(link.sourceId)}>
          {vault.graph.byId.get(link.sourceId)?.title} · {link.via}
        </button>
      ))}
    </div>
  )
})

const CustomProperty = observer(function CustomProperty() {
  const vault = useService(VaultService)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const known = new Set(['status', 'date', 'url', 'belongs_to', 'related_to'])
  const extra = Object.keys(vault.active?.properties ?? {}).filter((field) => !known.has(field))
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) return
        vault.updateProperty(name.trim(), value)
        setName('')
        setValue('')
      }}
    >
      {extra.map((field) => (
        <label className="field" key={field}>
          <span>{field}</span>
          <input value={vault.propertyText(field)} onChange={(event) => vault.updateProperty(field, event.target.value)} />
        </label>
      ))}
      <label className="field"><span>Custom field</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="supports" />
      </label>
      <label className="field"><span>Value</span>
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="[[Other note]]" />
      </label>
      <button type="submit">Add field</button>
    </form>
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

const Workspace = observer(function Workspace() {
  const vault = useService(VaultService)
  const note = vault.active
  return (
    <div className="shell" data-testid="vault-surface">
      <UpdateBanner />
      <header className="topbar">
        <div className="wordmark">Stride</div>
        <form className="search" onSubmit={(event) => { event.preventDefault(); void vault.runSearch() }}>
          <input data-testid="vault-search" value={vault.searchQuery} onChange={(event) => { vault.searchQuery = event.target.value }} placeholder="Search the vault" />
          <button type="submit" data-testid="run-search">Search</button>
          <button type="button" onClick={() => vault.clearSearch()}>Clear</button>
          <span className="search-mode" data-testid="search-mode">{vault.searchMode ? `Search mode ${vault.searchMode}` : ''}</span>
        </form>
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
              <input className="note-title" value={note.title} onChange={(event) => vault.updateTitle(event.target.value)} />
              <NoteEditor key={note.id} />
            </>
          ) : (
            <p className="empty-note">This vault has no notes yet.</p>
          )}
          {vault.error && <p className="error">{vault.error}</p>}
          {vault.broad && <p className="meta">This folder is a broad personal root. Git init stays off unless it is already a dedicated vault.</p>}
        </main>
        <aside className="panel">
          {vault.panel === 'properties' && <Properties />}
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
