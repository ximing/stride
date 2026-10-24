// "Customize icon and color" modal for a type document, opened from the
// type-row context menu. Writes `_icon` / `_color` through
// VaultService.updateTypeAppearance; `Auto` color writes `gray` (the title
// hash picks a real color, see resolveTypeColor in @stride/core).
import { observer, useService } from '@rabjs/react'
import { typeSidebarLabel } from '@stride/core'
import type { StrideNote } from '@stride/core/note'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VaultService } from '../../services/vault/vault.service'
import { Button } from '../primitives/button'
import { ColorSwatches } from '../primitives/color-swatches'
import { Mark } from '../primitives/icon'
import { Input } from '../primitives/input'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'
import { isEmojiIcon, TYPE_ICON_CHOICES, TYPE_ICONS } from './type-icons'

function propertyText(value: StrideNote['properties'][string] | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? ''
  return ''
}

function TypeCustomizeForm({ note, onClose }: { note: StrideNote; onClose: () => void }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const initialIcon = propertyText(note.properties._icon).trim()
  const initialColor = propertyText(note.properties._color).trim().toLowerCase()
  const [icon, setIcon] = useState(initialIcon)
  // gray is "auto": the hash decides. Everything else is a real choice.
  const [color, setColor] = useState(initialColor === 'gray' ? '' : initialColor)

  const emoji = isEmojiIcon(icon) ? icon : ''
  const lucideKey = icon.toLowerCase()
  const LucideGlyph = !isEmojiIcon(icon) && lucideKey in TYPE_ICONS ? TYPE_ICONS[lucideKey] : null

  const colorLabels: Record<string, string> = {
    auto: t('colors.auto'),
    gray: t('colors.gray'),
    blue: t('colors.blue'),
    teal: t('colors.teal'),
    green: t('colors.green'),
    orange: t('colors.orange'),
    purple: t('colors.purple'),
    red: t('colors.red'),
    pink: t('colors.pink'),
    yellow: t('colors.yellow'),
  }

  async function save() {
    const nextIcon = icon.trim() || 'note'
    const nextColor = color === '' ? 'gray' : color
    await vault.updateTypeAppearance(note.id, nextIcon, nextColor)
    onClose()
  }

  return (
    <div className="type-customize" data-testid="type-customize">
      <div className="type-customize-preview" data-testid="type-customize-preview">
        {emoji ? (
          <span className="type-customize-preview-emoji">{emoji}</span>
        ) : LucideGlyph ? (
          <Mark icon={LucideGlyph} size={20} />
        ) : (
          <Mark icon={TYPE_ICONS.note!} size={20} />
        )}
      </div>
      <Input
        label={t('types.emoji')}
        data-testid="type-customize-emoji"
        value={emoji}
        placeholder="🗂️"
        onChange={(event) => setIcon(event.target.value)}
      />
      <div className="type-customize-icons">
        <span className="sd-field-label">{t('types.pickIcon')}</span>
        <div className="type-customize-grid">
          {TYPE_ICON_CHOICES.map((key) => {
            const Glyph = TYPE_ICONS[key]
            if (!Glyph) return null
            return (
              <button
                key={key}
                type="button"
                className="type-customize-icon"
                data-testid={`type-customize-icon-${key}`}
                data-selected={!emoji && lucideKey === key ? 'true' : undefined}
                aria-label={key}
                aria-pressed={!emoji && lucideKey === key}
                title={key}
                onClick={() => setIcon(key)}
              >
                <Mark icon={Glyph} size={16} />
              </button>
            )
          })}
        </div>
      </div>
      <div className="type-customize-colors">
        <span className="sd-field-label">{t('types.color')}</span>
        <ColorSwatches
          value={color}
          onChange={setColor}
          withAuto
          autoValue=""
          labels={colorLabels}
          testId="type-customize-colors"
        />
      </div>
      <div className="sd-modal-actions">
        <ModalClose asChild>
          <Button tone="quiet" data-testid="type-customize-cancel">{t('common.cancel')}</Button>
        </ModalClose>
        <Button tone="primary" data-testid="type-customize-save" onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}

export const TypeCustomizeModal = observer(function TypeCustomizeModal({
  note,
  onClose,
}: {
  note: StrideNote | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <Modal open={note !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <ModalContent
        title={note ? t('types.customizeTitle', { name: typeSidebarLabel(note) }) : ''}
        description={t('types.customizeDescription')}
      >
        {note ? <TypeCustomizeForm key={note.id} note={note} onClose={onClose} /> : null}
      </ModalContent>
    </Modal>
  )
})
