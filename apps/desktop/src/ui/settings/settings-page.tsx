// Full-screen settings overlay (T7.1). Not a route and not an editor tab: a
// Radix dialog covering the workspace, so Esc, focus trapping, and focus
// restore come from Dialog. Open/close state lives in SettingsPageService;
// sections come from the registry in sections.ts.

import * as Dialog from '@radix-ui/react-dialog'
import { observer, useService } from '@rabjs/react'
import { X } from 'lucide-react'
import { SettingsPageService } from '../../services/settings/settings-page.service'
import { IconButton } from '../primitives/button'
import { Mark } from '../primitives/icon'
import { useDialogFocusRestore } from '../primitives/modal'
import { SETTINGS_SECTIONS } from './sections'
import './settings.css'

export const SettingsPage = observer(function SettingsPage() {
  const service = useService(SettingsPageService)
  const restoreFocus = useDialogFocusRestore(service.open)
  const active = SETTINGS_SECTIONS.find((section) => section.id === service.section) ?? SETTINGS_SECTIONS[0]
  const Body = active.component
  return (
    <Dialog.Root
      open={service.open}
      onOpenChange={(open) => {
        if (!open) service.close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          className="settings-page"
          data-testid="settings-page"
          aria-label="Settings"
          onCloseAutoFocus={restoreFocus}
        >
          <Dialog.Description className="settings-sr-only">
            Application settings, grouped by section.
          </Dialog.Description>
          <div className="settings-sidebar">
            <Dialog.Title className="settings-title">Settings</Dialog.Title>
            <nav className="settings-nav" aria-label="Settings sections">
              {SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="settings-nav-item"
                  data-testid={`settings-nav-${section.id}`}
                  aria-current={service.section === section.id ? 'page' : undefined}
                  onClick={() => service.select(section.id)}
                >
                  <Mark icon={section.icon} size={16} />
                  <span>{section.title}</span>
                </button>
              ))}
            </nav>
          </div>
          <div className="settings-content" data-testid="settings-content">
            <div className="settings-content-inner">
              <div className="settings-content-head">
                <h2 className="settings-section-title">{active.title}</h2>
                <Dialog.Close asChild>
                  <IconButton
                    icon={X}
                    label="Close settings"
                    className="settings-close"
                    data-testid="settings-close"
                  />
                </Dialog.Close>
              </div>
              <Body />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
})
