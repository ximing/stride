import { has, register, Service } from '@rabjs/react'
import manifest from '../../appCommandManifest.json'
import {
  commandForKeyEvent,
  parseAppCommandManifest,
  type AppCommand,
} from './commands'
import { RIGHT_PANEL_TABS } from '../layout/layout'
import { LayoutService } from '../layout/layout.service'
import { NoteListService } from '../notes/note-list.service'
import { GitService } from '../git/git.service'
import { QuickOpenService } from '../search/quick-open.service'
import { SearchPanelService } from '../search/search-panel.service'
import { SettingsPageService } from '../settings/settings-page.service'
import { TabsService } from '../notes/tabs.service'
import { UpdateCheckService } from '../update/update-check'
import { isDesktopRuntime } from '../platform/runtime'
import { requestNewProject, requestNewWindow, requestOpenProject } from '../platform/windows'
import { VaultService } from '../vault/vault.service'
import { ViewsService } from '../views/views.service'

export interface CommandHandler {
  run: () => void
  /** Extra runtime gate on top of `enabledWhen` (e.g. a service is only bound while its UI is mounted). */
  available?: () => boolean
}

function focusOverlayInput(selector: string) {
  if (typeof document === 'undefined') return
  document.querySelector<HTMLInputElement>(selector)?.focus()
}

// On desktop the native File menu owns New Window and Open Project, so the
// webview must not handle those chords as well. tab.close stays disabled
// because the desktop app does not bind Cmd+W; the command stays runnable from
// the palette, and tabs still close from the strip.
export const DESKTOP_DISABLED_SHORTCUTS = new Set(['tab.close', 'file.newWindow', 'file.openProject'])

/** Hint UI only. False on desktop for chords the webview does not dispatch. Manifest strings stay. */
export function showsShortcutHint(commandId: string): boolean {
  return !(DESKTOP_DISABLED_SHORTCUTS.has(commandId) && isDesktopRuntime())
}

/**
 * Single runtime registry for the app command manifest. Handlers only forward
 * to existing services; no business logic lives here. Manifest shortcuts are
 * dispatched once from the overlay key listener, so the palette, quick open,
 * search, and find bar do not each call this.
 */
export class CommandService extends Service {
  readonly commands: AppCommand[] = parseAppCommandManifest(manifest)

  private readonly handlers = new Map<string, CommandHandler>()

  private readonly conditions: Record<string, () => boolean> = {
    vaultReady: () => has(VaultService) && this.resolve(VaultService).phase === 'ready',
    hasActiveNote: () => has(VaultService) && this.resolve(VaultService).active !== null,
    gitReady: () => has(GitService) && this.resolve(GitService).surface === 'ready',
    canGoBack: () => has(TabsService) && this.resolve(TabsService).canGoBack,
    canGoForward: () => has(TabsService) && this.resolve(TabsService).canGoForward,
    hasListSelection: () => has(NoteListService) && this.resolve(NoteListService).hasMultiSelection,
  }

  constructor() {
    super()
    this.registerBuiltinHandlers()
  }

  /** Register (or replace) the executor for a command id. Returns an unregister function. */
  registerHandler(id: string, handler: CommandHandler): () => void {
    this.handlers.set(id, handler)
    // The map may be observability-wrapped, so unregister deletes unconditionally;
    // React runs effect cleanups before re-registering, keeping order sane.
    return () => {
      this.handlers.delete(id)
    }
  }

  /** Declarative gate from the manifest. Unknown conditions are disabled (validation prevents them). */
  isEnabled(command: AppCommand): boolean {
    if (!command.enabledWhen) return true
    return this.conditions[command.enabledWhen]?.() === true
  }

  /** Enabled *and* has a live handler. This is what UI greys out and what dispatch runs. */
  isRunnable(commandOrId: AppCommand | string): boolean {
    const command =
      typeof commandOrId === 'string' ? this.commands.find((item) => item.id === commandOrId) : commandOrId
    if (!command || !this.isEnabled(command)) return false
    const handler = this.handlers.get(command.id)
    if (!handler) return false
    return handler.available?.() ?? true
  }

  execute(id: string): boolean {
    const command = this.commands.find((item) => item.id === id)
    if (!command || !this.isRunnable(command)) return false
    this.handlers.get(command.id)?.run()
    return true
  }

  /**
   * Unified shortcut dispatcher: event → manifest match → enabled check → run.
   * A held key repeats; those repeats are ignored so Mod+N does not create a
   * note per repeat. `repeat` returns before preventDefault.
   *
   * Focus semantics: manifest chords are all Mod-based application commands, so
   * they fire no matter what element (input, textarea, editor) has focus — see
   * the policy comment in commands.ts. Overlay-local keys (arrows/Enter/Escape)
   * are not bindings; the frontmost overlay handles them, including key repeat.
   */
  dispatchKeydown(event: KeyboardEvent): boolean {
    if (event.repeat || event.defaultPrevented) return false
    const command = commandForKeyEvent(this.commands, event)
    if (!command || !this.isRunnable(command)) return false
    // See DESKTOP_DISABLED_SHORTCUTS: the OS/Tauri menu owns these chords on desktop.
    if (DESKTOP_DISABLED_SHORTCUTS.has(command.id) && isDesktopRuntime()) return false
    event.preventDefault()
    event.stopPropagation()
    this.execute(command.id)
    return true
  }

  private registerBuiltinHandlers() {
    this.registerHandler('file.newWindow', {
      available: () => has(VaultService),
      run: () => {
        requestNewWindow()
      },
    })
    this.registerHandler('file.newProject', {
      available: () => has(VaultService),
      run: () => {
        if (isDesktopRuntime()) requestNewProject()
        else void this.resolve(VaultService).createNewVault()
      },
    })
    this.registerHandler('file.openProject', {
      available: () => has(VaultService),
      run: () => {
        if (isDesktopRuntime()) requestOpenProject()
        else void this.resolve(VaultService).openFromDraft()
      },
    })
    this.registerHandler('file.newNote', {
      available: () => has(VaultService),
      run: () => {
        void this.resolve(VaultService).createNote()
      },
    })
    this.registerHandler('file.save', {
      available: () => has(VaultService),
      run: () => {
        void this.resolve(VaultService).flush()
      },
    })
    // The palette expands file.newInstance into one item per visible type.
    // The bare entry itself has nothing to run.
    this.registerHandler('file.newInstance', {
      available: () => has(VaultService),
      run: () => {},
    })
    this.registerHandler('nav.quickOpen', {
      available: () => has(VaultService) && has(QuickOpenService),
      run: () => {
        const service = this.resolve(QuickOpenService)
        if (service.open) focusOverlayInput('[data-testid="quick-open-input"]')
        else service.show()
      },
    })
    this.registerHandler('search.global', {
      available: () => has(VaultService) && has(SearchPanelService),
      run: () => {
        const service = this.resolve(SearchPanelService)
        if (service.open) focusOverlayInput('[data-testid="search-panel-input"]')
        else service.show()
      },
    })
    this.registerHandler('view.toggleSidebar', {
      run: () => this.resolve(LayoutService).toggleSidebar(),
    })
    this.registerHandler('view.toggleRightPanel', {
      run: () => this.resolve(LayoutService).toggleRightPanel(),
    })
    for (const tab of RIGHT_PANEL_TABS) {
      this.registerHandler(`view.tab.${tab}`, {
        run: () => this.resolve(LayoutService).setRightPanelTab(tab),
      })
    }
    // Settings is a full-screen overlay (T7.1), not a right-panel tab anymore.
    this.registerHandler('view.tab.settings', {
      available: () => has(SettingsPageService),
      run: () => this.resolve(SettingsPageService).show(),
    })
    this.registerHandler('ai.ask', {
      run: () => this.resolve(LayoutService).setRightPanelTab('chat'),
    })
    // Same code path as the status-bar "检查更新" button (T8.3). Hidden when
    // no updater can run here (plain browser dev).
    this.registerHandler('app.checkForUpdates', {
      available: () => has(UpdateCheckService) && this.resolve(UpdateCheckService).supported,
      run: () => {
        void this.resolve(UpdateCheckService).manualCheck()
      },
    })
    this.registerHandler('nav.goBack', {
      available: () => has(TabsService),
      run: () => this.resolve(TabsService).goBack(),
    })
    this.registerHandler('nav.goForward', {
      available: () => has(TabsService),
      run: () => this.resolve(TabsService).goForward(),
    })
    for (let index = 1; index <= 9; index += 1) {
      this.registerHandler(`tab.select${index}`, {
        available: () => has(TabsService),
        run: () => this.resolve(TabsService).selectTabAt(index - 1),
      })
    }
    this.registerHandler('tab.close', {
      available: () => has(TabsService),
      run: () => this.resolve(TabsService).closeActiveTab(),
    })
    // Batch list operations. Delete/retype open the same UI affordances the
    // batch bar drives (confirm modal / type menu), so the palette never
    // bypasses a confirmation.
    this.registerHandler('list.archiveSelected', {
      available: () => has(NoteListService),
      run: () => {
        void this.resolve(NoteListService).archiveSelected()
      },
    })
    this.registerHandler('list.deleteSelected', {
      available: () => has(NoteListService),
      run: () => {
        this.resolve(NoteListService).confirmingDelete = true
      },
    })
    this.registerHandler('list.retypeSelected', {
      available: () => has(NoteListService),
      run: () => {
        this.resolve(NoteListService).retypeOpen = true
      },
    })
    // Saved views: the palette opens the same editor modal the sidebar drives.
    this.registerHandler('view.saveCurrent', {
      available: () => has(ViewsService),
      run: () => this.resolve(ViewsService).openNewEditor(),
    })
    this.registerHandler('view.showAllNotes', {
      available: () => has(VaultService),
      run: () => this.resolve(VaultService).setFilter('all'),
    })
    // 'app.commandPalette' is registered by the CommandPalette component and
    // 'edit.find' by the editor find bar, because they need component closures.
  }
}

// Tests mount overlays without main.tsx, so the global service must exist on import.
if (!has(CommandService)) register(CommandService)
