import { observer, useService } from '@rabjs/react'
import { Book, Check, ChevronDown, PanelLeft, Plus, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CommandService } from '../../services/commands/command.service'
import { commandShortcut } from '../../services/commands/commands'
import { LayoutService } from '../../services/layout/layout.service'
import { isTauriRuntime } from '../../services/platform/deep-link'
import { VaultService } from '../../services/vault/vault.service'
import { Button, IconButton } from '../primitives/button'
import { Mark } from '../primitives/icon'
import { WindowControls } from './window-controls'

export const VaultSwitcher = observer(function VaultSwitcher() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="vault-switcher" ref={rootRef}>
      <Button
        ref={triggerRef}
        tone="quiet"
        size="sm"
        className="vault-switcher-trigger"
        data-testid="vault-switcher"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls="vault-switcher-options"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="statusbar-icon statusbar-icon-vault"><Mark icon={Book} size={14} /></span>
        <span className="vault-switcher-label">{vault.currentVaultLabel}</span>
        <Mark icon={ChevronDown} size={14} />
      </Button>
      {open && (
        <div className="vault-switcher-menu">
          <div className="vault-switcher-list" id="vault-switcher-options" role="listbox" aria-label={t('search.vaults')}>
            {vault.vaults.map((entry) => {
              const selected = entry.id === vault.activeVaultId
              return (
                <Button
                  key={entry.id}
                  tone="quiet"
                  size="sm"
                  role="option"
                  data-testid="vault-option"
                  data-vault-id={entry.id}
                  aria-selected={selected}
                  className={selected ? 'active' : ''}
                  onClick={() => {
                    setOpen(false)
                    void vault.switchVault(entry.id)
                  }}
                >
                  <span className="vault-option-label">{entry.label}</span>
                  {selected ? <Mark icon={Check} size={14} /> : null}
                </Button>
              )
            })}
          </div>
          <div className="vault-switcher-add">
            <Button
              tone="quiet"
              size="sm"
              data-testid="vault-add"
              icon={<Mark icon={Plus} size={14} />}
              onClick={() => {
                setOpen(false)
                void vault.showChooser()
              }}
            >
              {t('shell.addVault')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
})

const SidebarToggle = observer(function SidebarToggle() {
  const { t } = useTranslation()
  const layout = useService(LayoutService)
  return (
    <IconButton
      icon={PanelLeft}
      label={layout.sidebarCollapsed ? t('search.showSidebar') : t('search.hideSidebar')}
      className="rail-sidebar-toggle"
      data-testid="sidebar-toggle"
      active={!layout.sidebarCollapsed}
      aria-pressed={!layout.sidebarCollapsed}
      size="sm"
      onClick={() => layout.toggleSidebar()}
    />
  )
})

const RailSearch = observer(function RailSearch() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const commands = useService(CommandService)
  const searchKeys = commandShortcut(commands.commands, 'search.global')
  const degraded = vault.searchDegraded ? t('search.degraded') : ''
  const title = degraded || (searchKeys ? `${t('search.vault')} (${searchKeys})` : t('search.vault'))
  return (
    <span className="rail-search-slot">
      <IconButton
        icon={Search}
        label={t('search.vault')}
        title={title}
        className={degraded ? 'rail-search is-degraded' : 'rail-search'}
        data-testid="vault-search"
        size="sm"
        onClick={() => commands.execute('search.global')}
      />
      {degraded ? (
        <span className="rail-search-degraded" data-testid="search-degraded">{degraded}</span>
      ) : null}
    </span>
  )
})

/** Window buttons, sidebar toggle, and search. One row, aligned with the other column headers. */
export const RailChrome = observer(function RailChrome() {
  const desktop = isTauriRuntime()
  return (
    <div className="rail-chrome" data-tauri-drag-region="deep">
      {desktop ? <WindowControls /> : null}
      <SidebarToggle />
      <RailSearch />
      <div className="rail-drag" />
    </div>
  )
})

/** Window buttons, sidebar toggle, and search, shown in the note-list header when the rail is hidden. */
export const CollapsedChrome = observer(function CollapsedChrome() {
  const desktop = isTauriRuntime()
  return (
    <div className="collapsed-chrome">
      {desktop ? <WindowControls /> : null}
      <SidebarToggle />
      <RailSearch />
    </div>
  )
})
