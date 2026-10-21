// Settings dialog. Not a route and not an editor tab: a centered Radix dialog
// over the workspace, so the overlay, Esc, focus trapping, and focus restore
// come from Dialog. Open/close state lives in SettingsPageService; sections
// come from the registry in sections.ts.

import * as Dialog from '@radix-ui/react-dialog'
import { observer, useService } from '@rabjs/react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SettingsPageService } from '../../services/settings/settings-page.service'
import { IconButton } from '../primitives/button'
import { Mark } from '../primitives/icon'
import { useDialogFocusRestore } from '../primitives/modal'
import { SETTINGS_SECTIONS } from './sections'
import './settings.css'

export const SettingsPage = observer(function SettingsPage() {
  const { t } = useTranslation()
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
        <Dialog.Overlay className="sd-overlay settings-backdrop" />
        <Dialog.Content
          className="settings-page"
          data-testid="settings-page"
          aria-label={t('settings.title')}
          onCloseAutoFocus={restoreFocus}
        >
          <header className="settings-header">
            <Dialog.Title className="settings-title">{t('settings.title')}</Dialog.Title>
            <Dialog.Description className="settings-sr-only">
              {t('settings.description')}
            </Dialog.Description>
            <Dialog.Close asChild>
              <IconButton
                icon={X}
                label={t('settings.close')}
                className="settings-close"
                data-testid="settings-close"
              />
            </Dialog.Close>
          </header>
          <div className="settings-sidebar">
            <nav className="settings-nav" aria-label={t('settings.nav')}>
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
                  <span>{t(`settings.sections.${section.id}`)}</span>
                </button>
              ))}
            </nav>
          </div>
          <div className="settings-content" data-testid="settings-content">
            <div className="settings-content-inner">
              <h2 className="settings-section-title">{t(`settings.sections.${active.id}`)}</h2>
              <Body />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
})
