import { observer, useService } from '@rabjs/react'
import { Check, ChevronDown, PanelLeft, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CommandService } from '../services/command.service'
import { commandShortcut } from '../services/commands'
import { LayoutService } from '../services/layout.service'
import { VaultService } from '../services/vault.service'
import { Button, IconButton } from './button'
import { Mark } from './icon'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

export const VaultSwitcher = observer(function VaultSwitcher() {
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
        <span className="vault-switcher-label">{vault.currentVaultLabel}</span>
        <Mark icon={ChevronDown} size={14} />
      </Button>
      {open && (
        <div className="vault-switcher-list" id="vault-switcher-options" role="listbox" aria-label="Vaults">
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
      )}
    </div>
  )
})

export const TopBar = observer(function TopBar() {
  const vault = useService(VaultService)
  const layout = useService(LayoutService)
  const commands = useService(CommandService)
  // Shortcut hint reads the manifest via commandShortcut — no hard-coded chord.
  const searchKeys = commandShortcut(commands.commands, 'search.global')
  return (
    <header className="topbar">
      <IconButton
        icon={PanelLeft}
        label={layout.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        className="topbar-icon"
        data-testid="sidebar-toggle"
        active={!layout.sidebarCollapsed}
        aria-pressed={!layout.sidebarCollapsed}
        onClick={() => layout.toggleSidebar()}
      />
      <div className="brand">
        <div className="wordmark">Stride</div>
        <VaultSwitcher />
      </div>
      <form className="search" onSubmit={(event) => { event.preventDefault(); void vault.runSearch() }}>
        <div className="search-field">
          <span className="search-icon" aria-hidden="true"><Mark icon={Search} size={16} /></span>
          <Tooltip>
            <TooltipTrigger asChild>
              <input
                data-testid="vault-search"
                aria-label="Search the vault"
                value={vault.searchQuery}
                onChange={(event) => { vault.searchQuery = event.target.value }}
                placeholder="Search the vault"
              />
            </TooltipTrigger>
            {searchKeys ? <TooltipContent>全库搜索面板 {searchKeys}</TooltipContent> : null}
          </Tooltip>
          {vault.searchQuery.trim() !== '' && (
            <IconButton
              icon={X}
              label="Clear search"
              className="search-clear"
              onClick={() => vault.clearSearch()}
            />
          )}
        </div>
        <Button
          type="submit"
          tone="secondary"
          size="sm"
          className="search-submit"
          data-testid="run-search"
          icon={<Mark icon={Search} size={14} />}
        >
          Search
        </Button>
        <span className="search-mode" data-testid="search-mode">{vault.searchMode ? `Search mode ${vault.searchMode}` : ''}</span>
        {vault.searchDegraded ? <span className="search-degraded" data-testid="search-degraded">已降级为 BM25</span> : null}
      </form>
    </header>
  )
})
