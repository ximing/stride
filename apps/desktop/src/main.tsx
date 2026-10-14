import { register, resolve } from '@rabjs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ChatService, GitService, SettingsService, UpdateService } from './services/panels.service'
import { FolderService } from './services/folder.service'
import { ListFilterService } from './services/list-filter.service'
import { QuickOpenService } from './services/quick-open.service'
import { SearchPanelService } from './services/search-panel.service'
import { VaultService } from './services/vault.service'
import './styles.css'

const componentsPath = window.location.pathname
const showComponents = componentsPath === '/dev/components' || componentsPath.startsWith('/dev/components/')

if (showComponents) {
  void import('./dev/components-page').then(({ ComponentsPage }) => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ComponentsPage />
      </StrictMode>,
    )
  })
} else {
  register(VaultService)
  register(ListFilterService)
  register(QuickOpenService)
  register(SearchPanelService)
  register(FolderService)
  register(GitService)
  register(SettingsService)
  register(ChatService)
  register(UpdateService)

  void resolve(VaultService).restoreOpened()
  void resolve(SettingsService).load()

  if (import.meta.env.DEV) {
    void import('./inspect-client').then((mod) => mod.startInspectClient()).catch(() => undefined)
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
