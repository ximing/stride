import { useTranslation } from 'react-i18next'
import manifest from '../../../appCommandManifest.json'
import { commandTitle } from '../../../i18n'
import { showsShortcutHint } from '../../../services/commands/command.service'
import { formatShortcut, parseAppCommandManifest, type AppCommand } from '../../../services/commands/commands'

interface ShortcutGroup {
  section: string
  commands: AppCommand[]
}

/**
 * Read-only shortcut reference: every manifest command grouped by its manifest
 * section, in manifest order. Rebinding is deliberately out of scope for T7.1.
 */
function groupBySection(commands: readonly AppCommand[]): ShortcutGroup[] {
  const groups: ShortcutGroup[] = []
  const bySection = new Map<string, ShortcutGroup>()
  for (const command of commands) {
    let group = bySection.get(command.section)
    if (!group) {
      group = { section: command.section, commands: [] }
      bySection.set(command.section, group)
      groups.push(group)
    }
    group.commands.push(command)
  }
  return groups
}

const SHORTCUT_GROUPS = groupBySection(parseAppCommandManifest(manifest))

export function ShortcutsSection() {
  const { t } = useTranslation()
  return (
    <div className="settings-shortcuts" data-testid="settings-section-shortcuts">
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.section} className="settings-shortcut-group" data-section={group.section}>
          <h3 className="settings-shortcut-heading">{t('commands.section.' + group.section, { defaultValue: group.section })}</h3>
          <ul className="settings-shortcut-list">
            {group.commands.map((command) => (
              <li key={command.id} className="settings-shortcut-row" data-command-id={command.id}>
                <span className="settings-shortcut-title">{commandTitle(command.id, command.title)}</span>
                {command.shortcut && showsShortcutHint(command.id) ? (
                  <kbd className="settings-shortcut-kbd">{formatShortcut(command.shortcut)}</kbd>
                ) : (
                  <span className="settings-shortcut-none">{t('settings.shortcuts.none')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
