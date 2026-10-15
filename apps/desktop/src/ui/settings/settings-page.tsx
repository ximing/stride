// Full-screen settings overlay (T7.1). Not a route and not an editor tab: a
// Radix dialog covering the workspace, so Esc, focus trapping, and focus
// restore come from Dialog. Open/close state lives in SettingsPageService;
// sections come from the registry in sections.ts.

import { X } from '@phosphor-icons/react/X'
import * as Dialog from '@radix-ui/react-dialog'
import { observer, useService } from '@rabjs/react'
import { SettingsPageService } from '../../services/settings-page.service'
import { Mark } from '../icon'
import { SETTINGS_SECTIONS } from './sections'
import './settings.css'

export const SettingsPage = observer(function SettingsPage() {
  const service = useService(SettingsPageService)
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
        <Dialog.Content className="settings-page" data-testid="settings-page" aria-label="Settings">
          <Dialog.Title className="settings-title">Settings</Dialog.Title>
          <Dialog.Description className="settings-sr-only">
            Application settings, grouped by section.
          </Dialog.Description>
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
                {section.title}
              </button>
            ))}
          </nav>
          <div className="settings-content" data-testid="settings-content">
            <div className="settings-content-head">
              <h2 className="settings-section-title">{active.title}</h2>
              <Dialog.Close className="settings-close" data-testid="settings-close" aria-label="Close settings">
                <Mark icon={X} size={16} />
              </Dialog.Close>
            </div>
            <Body />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
})
