import { observer, useService } from '@rabjs/react'
import { Check, ChevronDown, Files, Inbox, PanelLeft, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CommandService } from '../../services/commands/command.service'
import { commandShortcut } from '../../services/commands/commands'
import { LayoutService } from '../../services/layout/layout.service'
import { isTauriRuntime } from '../../services/platform/deep-link'
import { VaultService } from '../../services/vault/vault.service'
import { vaultDisplayName } from '../../services/vault/vault-registry'
import { Button, IconButton } from '../primitives/button'
import { Input } from '../primitives/input'
import { Mark } from '../primitives/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/popover'
import { WindowControls } from './window-controls'

export const VaultSwitcher = observer(function VaultSwitcher({ side = 'bottom' }: { side?: 'top' | 'bottom' }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [open, setOpen] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')
  const active = vault.vaults.find((entry) => entry.id === vault.activeVaultId)
  const activePath = active?.label ?? ''

  const commitAlias = () => {
    if (!active) return
    vault.setVaultAlias(active.id, aliasDraft)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setAliasDraft(active?.alias ?? '')
      }}
    >
      <div className="vault-switcher">
        <PopoverTrigger asChild>
          <Button
            tone="quiet"
            size="sm"
            className="vault-switcher-trigger"
            data-testid="vault-switcher"
            aria-haspopup="listbox"
            aria-controls="vault-switcher-options"
            title={activePath || undefined}
          >
            <span className="vault-switcher-label">{vault.currentVaultLabel}</span>
            <Mark icon={ChevronDown} size={14} />
          </Button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        side={side}
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="vault-switcher-menu"
        data-tauri-drag-region="false"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
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
                title={entry.label}
                onClick={() => {
                  setOpen(false)
                  void vault.switchVault(entry.id)
                }}
              >
                <span className="vault-option-label">{vaultDisplayName(entry)}</span>
                {selected ? <Mark icon={Check} size={14} /> : null}
              </Button>
            )
          })}
        </div>
        {active ? (
          <div className="vault-switcher-alias">
            <Input
              label={t('shell.vaultAlias')}
              data-testid="vault-alias"
              value={aliasDraft}
              placeholder={vaultDisplayName({ label: activePath })}
              spellCheck={false}
              onChange={(event) => setAliasDraft(event.target.value)}
              onBlur={commitAlias}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                commitAlias()
              }}
            />
            {activePath && activePath !== vaultDisplayName(active) ? (
              <p className="vault-switcher-path" title={activePath}>{activePath}</p>
            ) : null}
          </div>
        ) : null}
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
      </PopoverContent>
    </Popover>
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

function useSearchHint() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const commands = useService(CommandService)
  const searchKeys = commandShortcut(commands.commands, 'search.global')
  const degraded = vault.searchDegraded ? t('search.degraded') : ''
  const title = degraded || (searchKeys ? `${t('search.vault')} (${searchKeys})` : t('search.vault'))
  return { commands, searchKeys, degraded, title, t }
}

/** Full-width pseudo input under the rail header; opens global search. */
export const RailSearchField = observer(function RailSearchField() {
  const { commands, searchKeys, degraded, title, t } = useSearchHint()
  return (
    <div className="rail-search-block">
      <button
        type="button"
        className="rail-search-field"
        data-testid="vault-search"
        title={title}
        onClick={() => commands.execute('search.global')}
      >
        <Mark icon={Search} size={14} />
        <span className="rail-search-placeholder">{t('search.allNotes')}</span>
        {searchKeys ? <kbd className="rail-search-kbd">{searchKeys}</kbd> : null}
      </button>
      {degraded ? (
        <span className="rail-search-degraded" data-testid="search-degraded">{degraded}</span>
      ) : null}
    </div>
  )
})

/** Window buttons, vault switcher, and the sidebar toggle. One 40px row. */
export const RailChrome = observer(function RailChrome() {
  const desktop = isTauriRuntime()
  return (
    <div className="rail-chrome" data-tauri-drag-region="deep">
      {desktop ? <WindowControls /> : null}
      <VaultSwitcher />
      <div className="rail-drag" />
      <SidebarToggle />
    </div>
  )
})

/** Activity rail shown while the sidebar is collapsed. */
export const RailMini = observer(function RailMini() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const { commands, degraded, title } = useSearchHint()
  const desktop = isTauriRuntime()
  return (
    <aside className="rail-mini" data-tauri-drag-region="deep">
      {desktop ? <WindowControls /> : null}
      <SidebarToggle />
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
      <div className="rail-mini-divider" />
      <IconButton
        icon={Files}
        label={t('sidebar.all')}
        active={vault.listFilter === 'all'}
        size="sm"
        onClick={() => vault.setFilter('all')}
      />
      <IconButton
        icon={Inbox}
        label={t('sidebar.inbox')}
        active={vault.listFilter === 'inbox'}
        data-testid="rail-inbox"
        size="sm"
        onClick={() => vault.setFilter('inbox')}
      />
    </aside>
  )
})
