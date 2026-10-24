import { observer, useService } from '@rabjs/react'
import type { StrideNote } from '@stride/core/note'
import { FileText, Files, Inbox, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { typeColorKey, typeSidebarLabel } from '@stride/core'
import type { ContextMenuEntry } from '../../services/commands/context-menu'
import { LayoutService } from '../../services/layout/layout.service'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { ViewsService } from '../../services/views/views.service'
import { FolderTree } from '../folders/folder-tree'
import { ContextMenu } from '../overlays/context-menu'
import { IconButton } from '../primitives/button'
import { EmptyState } from '../primitives/empty-state'
import { Mark } from '../primitives/icon'
import { ViewEditorModal } from '../views/view-editor'
import { RailGroupHeader } from './rail-group'
import { TypeCustomizeModal } from './type-customize'
import { TYPE_ICONS, typeIconView } from './type-icons'

/** dataTransfer mime for view-row drags (dataTransfer.types lowercases types). */
const VIEW_DRAG_MIME = 'application/x-stride-view'

/**
 * Saved views (`views/*.json`): click activates the view (listFilter becomes
 * `view:<slug>`), the pencil opens the editor modal, and HTML5 drag reorders
 * rows (persisted to `.stride/views-order.json` by ViewsService). The New view
 * entry point is the + on the group header (Rail), not a row here.
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
            {item.view.icon ? (
              <span className={item.view.color ? `view-icon view-icon-${item.view.color}` : 'view-icon'}>
                {item.view.icon}
              </span>
            ) : null}
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
    </>
  )
})

/** One type row: filter link + hover-revealed new-instance + context menu. */
function TypeRow({
  note,
  onMenu,
}: {
  note: StrideNote
  onMenu: (note: StrideNote, x: number, y: number) => void
}) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const tabs = useService(TabsService)
  const icon = typeIconView(note)
  const color = typeColorKey(note)
  const active = vault.listFilter === note.title
  return (
    <div
      className="type-row"
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(note, event.clientX, event.clientY)
      }}
    >
      <button
        type="button"
        data-testid="type-link"
        data-type={note.title}
        data-icon={icon.kind === 'emoji' ? 'emoji' : icon.key}
        className={active ? 'active' : ''}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          vault.setFilter(note.title)
          tabs.openNote(note.id)
        }}
      >
        <span className={`type-icon type-icon-${color}`}>
          {icon.kind === 'emoji' ? (
            <span className="type-icon-emoji">{icon.value}</span>
          ) : (
            <Mark icon={TYPE_ICONS[icon.key] ?? FileText} size={16} />
          )}
        </span>
        <span className="type-label">{typeSidebarLabel(note)}</span>
      </button>
      <IconButton
        icon={Plus}
        label={t('sidebar.newOfType', { title: note.title })}
        className="type-add"
        data-testid="type-new-instance"
        data-type={note.title}
        onClick={() => vault.createInstance(note.title)}
      />
    </div>
  )
}

export const Rail = observer(function Rail() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const views = useService(ViewsService)
  const tabs = useService(TabsService)
  const layout = useService(LayoutService)
  const [inboxMenu, setInboxMenu] = useState<{ x: number; y: number } | null>(null)
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number; note: StrideNote } | null>(null)
  const [customizing, setCustomizing] = useState<StrideNote | null>(null)
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
  const typeMenuItems: ContextMenuEntry[] = typeMenu
    ? [
        {
          kind: 'item',
          id: 'customize-type',
          label: t('sidebar.customizeType'),
          onSelect: () => setCustomizing(typeMenu.note),
        },
      ]
    : []
  return (
    <div className="rail-inner">
      {/* Pinned destinations: no group label, never collapsible. */}
      <div className="rail-pinned">
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
          <span className="type-label">{t('sidebar.inbox')}</span>
          <span className="rail-nav-count">{vault.inboxCount}</span>
        </button>
      </div>
      {inboxMenu && (
        <ContextMenu
          x={inboxMenu.x}
          y={inboxMenu.y}
          items={inboxMenuItems}
          onClose={() => setInboxMenu(null)}
        />
      )}
      {typeMenu && (
        <ContextMenu
          x={typeMenu.x}
          y={typeMenu.y}
          items={typeMenuItems}
          onClose={() => setTypeMenu(null)}
        />
      )}
      <section className="rail-group" data-testid="rail-group-views" data-collapsed={layout.railCollapsed.views || undefined}>
        <RailGroupHeader
          title={t('sidebar.views')}
          collapsed={layout.railCollapsed.views}
          onToggle={() => layout.toggleRailSection('views')}
          action={
            <IconButton
              icon={Plus}
              iconSize={14}
              size="sm"
              label={t('sidebar.newView')}
              data-testid="new-view"
              onClick={() => views.openNewEditor()}
            />
          }
        />
        {!layout.railCollapsed.views && (
          <div className="rail-group-body">
            <SavedViews />
          </div>
        )}
      </section>
      <section className="rail-group" data-testid="rail-group-types" data-collapsed={layout.railCollapsed.types || undefined}>
        <RailGroupHeader
          title={t('sidebar.types')}
          collapsed={layout.railCollapsed.types}
          onToggle={() => layout.toggleRailSection('types')}
          action={
            <IconButton
              icon={Plus}
              iconSize={14}
              size="sm"
              label={t('sidebar.newType')}
              data-testid="new-type"
              onClick={() => vault.createType()}
            />
          }
        />
        {!layout.railCollapsed.types && (
          <div className="rail-group-body">
            {typeDocs.length === 0 && fallbackTypes.length === 0 && (
              <EmptyState compact title={t('sidebar.noTypes')} testId="types-empty" />
            )}
            {typeDocs.map((note) => (
              <TypeRow
                key={note.id}
                note={note}
                onMenu={(target, x, y) => setTypeMenu({ x, y, note: target })}
              />
            ))}
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
          </div>
        )}
      </section>
      <FolderTree />
      <ViewEditorModal />
      <TypeCustomizeModal note={customizing} onClose={() => setCustomizing(null)} />
    </div>
  )
})
