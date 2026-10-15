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
import type { StrideNote } from '@stride/core/note'
import { typeSidebarLabel } from '../../../../packages/core/src/types'
import { TabsService } from '../services/tabs.service'
import { VaultService } from '../services/vault.service'
import { FolderTree } from './folder-tree'
import { Mark } from './icon'

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
