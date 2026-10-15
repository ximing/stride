import { Sidebar as SidebarIcon } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { useState } from 'react'
import { LayoutService } from '../services/layout.service'
import { VaultService } from '../services/vault.service'
import { Mark } from './icon'

export const VaultSwitcher = observer(function VaultSwitcher() {
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

export const TopBar = observer(function TopBar() {
  const vault = useService(VaultService)
  const layout = useService(LayoutService)
  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar-icon"
        data-testid="sidebar-toggle"
        aria-label={layout.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!layout.sidebarCollapsed}
        onClick={() => layout.toggleSidebar()}
      >
        <Mark icon={SidebarIcon} size={17} />
      </button>
      <div className="brand">
        <div className="wordmark">Stride</div>
        <VaultSwitcher />
      </div>
      <form className="search" onSubmit={(event) => { event.preventDefault(); void vault.runSearch() }}>
        <input data-testid="vault-search" value={vault.searchQuery} onChange={(event) => { vault.searchQuery = event.target.value }} placeholder="Search the vault" />
        <button type="submit" data-testid="run-search">Search</button>
        {vault.searchQuery.trim() !== '' && (
          <button type="button" onClick={() => vault.clearSearch()}>Clear</button>
        )}
        <span className="search-mode" data-testid="search-mode">{vault.searchMode ? `Search mode ${vault.searchMode}` : ''}</span>
        {vault.searchDegraded ? <span className="search-degraded" data-testid="search-degraded">已降级为 BM25</span> : null}
      </form>
    </header>
  )
})
