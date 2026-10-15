import { register, resolve } from '@rabjs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ChatService, GitService, SettingsService, UpdateService } from './services/panels.service'
import { CommandPaletteService } from './services/command-palette.service'
import { CommandService } from './services/command.service'
import { FolderService } from './services/folder.service'
import { LayoutService } from './services/layout.service'
import { ListFilterService } from './services/list-filter.service'
import { NoteListService } from './services/note-list.service'
import { QuickOpenService } from './services/quick-open.service'
import { SearchPanelService } from './services/search-panel.service'
import { TabsService } from './services/tabs.service'
import { VaultService } from './services/vault.service'
import { ViewsService } from './services/views.service'
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
  register(ViewsService)
  register(TabsService)
  register(ListFilterService)
  register(NoteListService)
  register(LayoutService)
  register(QuickOpenService)
  register(SearchPanelService)
  register(CommandService)
  register(CommandPaletteService)
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
