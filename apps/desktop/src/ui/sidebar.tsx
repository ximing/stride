import type { Icon } from '@phosphor-icons/react'
import { Bookmark } from '@phosphor-icons/react/Bookmark'
import { Briefcase } from '@phosphor-icons/react/Briefcase'
import { Calendar } from '@phosphor-icons/react/Calendar'
import { Folder } from '@phosphor-icons/react/Folder'
import { Note } from '@phosphor-icons/react/Note'
import { PencilSimple } from '@phosphor-icons/react/PencilSimple'
import { Star } from '@phosphor-icons/react/Star'
import { Tag } from '@phosphor-icons/react/Tag'
import { User } from '@phosphor-icons/react/User'
import { observer, useService } from '@rabjs/react'
import type { StrideNote } from '@stride/core/note'
import { useState } from 'react'
import { typeSidebarLabel } from '../../../../packages/core/src/types'
import { TabsService } from '../services/tabs.service'
import { VaultService } from '../services/vault.service'
import { ViewsService } from '../services/views.service'
import { FolderTree } from './folder-tree'
import { Mark } from './icon'
import { ViewEditorModal } from './view-editor'

/** dataTransfer mime for view-row drags (dataTransfer.types lowercases types). */
const VIEW_DRAG_MIME = 'application/x-stride-view'

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

/**
 * Saved views (`views/*.json`): click activates the view (listFilter becomes
 * `view:<slug>`), the pencil opens the editor modal, and HTML5 drag reorders
 * rows (persisted to `.stride/views-order.json` by ViewsService).
 */
const SavedViews = observer(function SavedViews() {
  const views = useService(ViewsService)
  const [dropTarget, setDropTarget] = useState('')
  return (
    <>
      {views.views.map((item) => (
        <div
          className="view-row"
          key={item.file}
          data-testid="view-row"
          data-view={item.file}
          data-drop-target={dropTarget === item.file ? 'true' : undefined}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(VIEW_DRAG_MIME, item.file)
            event.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(VIEW_DRAG_MIME)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (dropTarget !== item.file) setDropTarget(item.file)
          }}
          onDrop={(event) => {
            const dragged = event.dataTransfer.getData(VIEW_DRAG_MIME)
            event.preventDefault()
            setDropTarget('')
            if (dragged) void views.moveView(dragged, item.file)
          }}
          onDragEnd={() => setDropTarget('')}
        >
          <button
            type="button"
            data-testid="view-link"
            data-view={item.file}
            className={views.isActive(item.file) ? 'active' : ''}
            onClick={() => views.activate(item.file)}
          >
            {item.view.icon ? <span className="view-icon">{item.view.icon}</span> : null}
            <span className="type-label">{item.view.name}</span>
          </button>
          <button
            type="button"
            className="view-edit"
            data-testid="view-edit"
            data-view={item.file}
            aria-label={`Edit ${item.view.name}`}
            onClick={() => views.openEditor(item.file)}
          >
            <Mark icon={PencilSimple} size={13} />
          </button>
        </div>
      ))}
      <button type="button" data-testid="new-view" onClick={() => views.openNewEditor()}>
        New view
      </button>
      <ViewEditorModal />
    </>
  )
})

export const Rail = observer(function Rail() {
  const vault = useService(VaultService)
  const tabs = useService(TabsService)
  const typeDocs = vault.sidebarTypes
  const fallbackTypes = vault.typeDocuments.length === 0 ? [...vault.graph.byType.keys()] : []
  const showInstances = vault.active?.type === 'Type'
  return (
    <div className="rail-inner">
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
      <SavedViews />
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
                tabs.openNote(note.id)
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
              onClick={() => tabs.openNote(note.id)}
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
    </div>
  )
})
