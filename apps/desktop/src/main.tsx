import './i18n'
import { register, resolve } from '@rabjs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ChatService } from './services/chat/chat.service'
import { GitService } from './services/git/git.service'
import { SettingsService } from './services/settings/settings.service'
import { UpdateService } from './services/update/update.service'
import { CommandPaletteService } from './services/commands/command-palette.service'
import { CommandService } from './services/commands/command.service'
import { startDeepLinkListener } from './services/platform/deep-link'
import { applyWindowIntent, installDesktopWindowBridge, publishDesktopMenusFromStorage, readStartupIntent } from './services/platform/windows'
import { bindDesktopWindowFrame } from './ui/shell/window-controls'
import { FolderService } from './services/vault/folder.service'
import { LayoutService } from './services/layout/layout.service'
import { ListFilterService } from './services/search/list-filter.service'
import { NoteListService } from './services/notes/note-list.service'
import { QuickOpenService } from './services/search/quick-open.service'
import { SearchPanelService } from './services/search/search-panel.service'
import { SettingsPageService } from './services/settings/settings-page.service'
import { TabsService } from './services/notes/tabs.service'
import { applyStoredTheme } from './services/appearance/theme'
import { LocaleService } from './services/appearance/locale.service'
import { ThemeService } from './services/appearance/theme.service'
import { scheduleUpdateAutocheck, UpdateCheckService } from './services/update/update-check'
import { VaultService } from './services/vault/vault.service'
import { ViewsService } from './services/views/views.service'
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
bindDesktopWindowFrame()

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
  register(LocaleService)

  const vault = resolve(VaultService)
  installDesktopWindowBridge(vault)
  void (async () => {
    const intent = await readStartupIntent()
    await applyWindowIntent(vault, intent)
    publishDesktopMenusFromStorage()
  })()
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
