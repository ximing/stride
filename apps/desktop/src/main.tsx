import { register, resolve } from '@rabjs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ChatService, GitService, SettingsService, UpdateService } from './services/panels.service'
import { CommandPaletteService } from './services/command-palette.service'
import { CommandService } from './services/command.service'
import { startDeepLinkListener } from './services/deep-link'
import { FolderService } from './services/folder.service'
import { LayoutService } from './services/layout.service'
import { ListFilterService } from './services/list-filter.service'
import { NoteListService } from './services/note-list.service'
import { QuickOpenService } from './services/quick-open.service'
import { SearchPanelService } from './services/search-panel.service'
import { SettingsPageService } from './services/settings-page.service'
import { TabsService } from './services/tabs.service'
import { applyStoredTheme } from './services/theme'
import { ThemeService } from './services/theme.service'
import { scheduleUpdateAutocheck, UpdateCheckService } from './services/update-check'
import { VaultService } from './services/vault.service'
import { ViewsService } from './services/views.service'
import './ui/tokens.css'
import './styles.css'
import './ui/primitives.css'
import './ui/shell.css'
import './ui/panels.css'
import './ui/overlays.css'
import './editor/chrome.css'

// Apply the persisted theme synchronously, before the first paint, so the app
// never flashes the wrong palette (system removes the attribute; light/dark
// set an explicit override on <html>).
applyStoredTheme()

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
  register(SettingsPageService)
  register(CommandService)
  register(CommandPaletteService)
  register(FolderService)
  register(GitService)
  register(SettingsService)
  register(ChatService)
  register(UpdateService)
  register(UpdateCheckService)
  register(ThemeService)

  void resolve(VaultService).restoreOpened()
  void resolve(SettingsService).load()

  // T8.3: one silent update check a few seconds after launch; the
  // updates.autoCheck switch is read when the timer fires.
  scheduleUpdateAutocheck()

  // T8.6: receive `stride://` deep links (log + DOM event; vault routing is
  // Phase 9). No-op in a plain browser.
  startDeepLinkListener()

  if (import.meta.env.DEV) {
    void import('./inspect-client').then((mod) => mod.startInspectClient()).catch(() => undefined)
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
