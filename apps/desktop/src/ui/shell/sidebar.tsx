import { observer, useService } from '@rabjs/react'
import type { StrideNote } from '@stride/core/note'
import {
  Bookmark,
  Briefcase,
  Calendar,
  ChevronDown,
  ChevronRight,
  FileText,
  Files,
  Folder,
  Inbox,
  Pencil,
  Plus,
  Star,
  Tag,
  User,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { typeSidebarLabel } from '../../../../../packages/core/src/types'
import type { ContextMenuEntry } from '../../services/commands/context-menu'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { ViewsService } from '../../services/views/views.service'
import { FolderTree } from '../folders/folder-tree'
import { ContextMenu } from '../overlays/context-menu'
import { Button, IconButton } from '../primitives/button'
import { EmptyState } from '../primitives/empty-state'
import { Mark } from '../primitives/icon'
import { ViewEditorModal } from '../views/view-editor'

/** dataTransfer mime for view-row drags (dataTransfer.types lowercases types). */
const VIEW_DRAG_MIME = 'application/x-stride-view'

const TYPE_ICONS: Record<string, LucideIcon> = {
  note: FileText,
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
  const { t } = useTranslation()
  const views = useService(ViewsService)
  const [dropTarget, setDropTarget] = useState('')
  return (
    <>
      {views.views.length === 0 && (
        <EmptyState compact title={t('sidebar.noViews')} testId="views-empty" />
      )}
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
            aria-current={views.isActive(item.file) ? 'page' : undefined}
            onClick={() => views.activate(item.file)}
          >
            {item.view.icon ? <span className="view-icon">{item.view.icon}</span> : null}
            <span className="type-label">{item.view.name}</span>
          </button>
          <IconButton
            icon={Pencil}
            label={t('sidebar.editView', { name: item.view.name })}
            className="view-edit"
            data-testid="view-edit"
            data-view={item.file}
            onClick={() => views.openEditor(item.file)}
          />
        </div>
      ))}
      <Button
        tone="quiet"
        size="sm"
        className="rail-quiet-action"
        data-testid="new-view"
        icon={<Mark icon={Plus} size={14} />}
        onClick={() => views.openNewEditor()}
      >
        {t('sidebar.newView')}
      </Button>
      <ViewEditorModal />
    </>
  )
})

export const Rail = observer(function Rail() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const tabs = useService(TabsService)
  const [inboxMenu, setInboxMenu] = useState<{ x: number; y: number } | null>(null)
  const typeDocs = vault.sidebarTypes
  const fallbackTypes = vault.typeDocuments.length === 0 ? [...vault.graph.byType.keys()] : []
  const showInstances = vault.active?.type === 'Type'
  const inboxMenuItems: ContextMenuEntry[] = [
    {
      kind: 'item',
      id: 'advance-inbox',
      label: t('sidebar.advance'),
      checked: vault.advanceInbox,
      onSelect: () => {
        void vault.setAdvanceInbox(!vault.advanceInbox)
      },
    },
  ]
  return (
    <div className="rail-inner">
      <div className="group-label">{t('sidebar.views')}</div>
      <button
        type="button"
        className={vault.listFilter === 'all' ? 'rail-nav-item active' : 'rail-nav-item'}
        aria-current={vault.listFilter === 'all' ? 'page' : undefined}
        onClick={() => vault.setFilter('all')}
      >
        <span className="rail-nav-icon"><Mark icon={Files} size={16} /></span>
        <span className="type-label">{t('sidebar.all')}</span>
      </button>
      <button
        type="button"
        className={vault.listFilter === 'inbox' ? 'rail-nav-item active' : 'rail-nav-item'}
        data-testid="rail-inbox"
        aria-current={vault.listFilter === 'inbox' ? 'page' : undefined}
        onClick={() => vault.setFilter('inbox')}
        onContextMenu={(event) => {
          event.preventDefault()
          setInboxMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <span className="rail-nav-icon"><Mark icon={Inbox} size={16} /></span>
        <span className="type-label">{t('sidebar.inboxCount', { n: vault.inboxCount })}</span>
      </button>
      {inboxMenu && (
        <ContextMenu
          x={inboxMenu.x}
          y={inboxMenu.y}
          items={inboxMenuItems}
          onClose={() => setInboxMenu(null)}
        />
      )}
      <SavedViews />
      <div className="group-label">{t('sidebar.types')}</div>
      {typeDocs.length === 0 && fallbackTypes.length === 0 && (
        <EmptyState compact title={t('sidebar.noTypes')} testId="types-empty" />
      )}
      {typeDocs.map((note) => {
        const icon = typeIconKey(note)
        const color = typeColorKey(note)
        const collapsed = vault.collapsedTypes.includes(note.title)
        const active = vault.listFilter === note.title
        return (
          <div className="type-row" key={note.id}>
            <button
              type="button"
              data-testid="type-link"
              data-type={note.title}
              data-icon={icon}
              className={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                vault.setFilter(note.title)
                tabs.openNote(note.id)
              }}
            >
              <span className={`type-dot type-dot-${color}`} />
              <span className="type-icon"><Mark icon={TYPE_ICONS[icon] ?? FileText} size={16} /></span>
              <span className="type-label">{typeSidebarLabel(note)}</span>
            </button>
            {collapsed ? null : (
              <IconButton
                icon={Plus}
                label={t('sidebar.newOfType', { title: note.title })}
                className="type-add"
                data-testid="type-new-instance"
                data-type={note.title}
                onClick={() => vault.createInstance(note.title)}
              />
            )}
            <IconButton
              icon={collapsed ? ChevronRight : ChevronDown}
              label={collapsed ? t('sidebar.expand', { title: note.title }) : t('sidebar.collapse', { title: note.title })}
              className="type-collapse"
              data-testid="type-collapse"
              data-type={note.title}
              aria-expanded={!collapsed}
              onClick={() => vault.toggleTypeCollapsed(note.title)}
            />
          </div>
        )
      })}
      <Button
        tone="quiet"
        size="sm"
        className="rail-quiet-action"
        data-testid="new-type"
        icon={<Mark icon={Plus} size={14} />}
        onClick={() => vault.createType()}
      >
        {t('sidebar.newType')}
      </Button>
      {showInstances && (
        <div className="type-instances" data-testid="type-instances">
          <div className="group-label">{t('sidebar.instances')}</div>
          {vault.typeInstances.length === 0 && <EmptyState compact title={t('sidebar.noInstances')} testId="instances-empty" />}
          {vault.typeInstances.map((note) => (
            <button
              key={note.id}
              type="button"
              data-testid="instance-link"
              className={vault.activeId === note.id ? 'rail-nav-item active' : 'rail-nav-item'}
              aria-current={vault.activeId === note.id ? 'page' : undefined}
              onClick={() => tabs.openNote(note.id)}
            >
              <span className="rail-nav-icon"><Mark icon={FileText} size={16} /></span>
              <span className="type-label">{note.title}</span>
            </button>
          ))}
        </div>
      )}
      {fallbackTypes.map((type) => (
        <button
          key={type}
          type="button"
          className={vault.listFilter === type ? 'rail-nav-item active' : 'rail-nav-item'}
          aria-current={vault.listFilter === type ? 'page' : undefined}
          onClick={() => vault.setFilter(type)}
        >
          <span className="rail-nav-icon"><Mark icon={FileText} size={16} /></span>
          <span className="type-label">{type}</span>
        </button>
      ))}
      <FolderTree />
    </div>
  )
})
