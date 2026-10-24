import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '../primitives/button'
import { Combobox, type ComboboxOption } from '../primitives/combobox'

/**
 * Chips editor for list properties: existing items render as removable chips,
 * a trailing inline input appends on Enter/comma (or on blur), and Backspace on
 * an empty input removes the last chip. Owned by the properties panel, so the
 * add/remove semantics live in the VaultService callbacks the caller passes.
 * When `options` are given (tags, links), the input becomes a searchable
 * combobox that can also create free-form entries.
 */
export function ListEditor({
  items,
  placeholder,
  onAdd,
  onRemoveAt,
  options,
}: {
  items: string[]
  placeholder: string
  onAdd: (item: string) => void
  onRemoveAt: (index: number) => void
  options?: ComboboxOption[]
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const commit = () => {
    const item = draft.trim()
    if (item) onAdd(item)
    setDraft('')
  }
  return (
    <div className="sd-chips" data-testid="list-editor">
      {items.map((item, index) => (
        <span className="sd-chip" data-testid="list-item" key={`${index}-${item}`}>
          <span className="sd-chip-text">{item}</span>
          <IconButton
            className="sd-chip-remove"
            data-testid="list-item-remove"
            data-index={index}
            icon={X}
            iconSize={12}
            label={t('panels.remove', { name: item })}
            size="sm"
            onClick={() => onRemoveAt(index)}
          />
        </span>
      ))}
      {options ? (
        <Combobox
          multiple
          values={items}
          options={options}
          allowCreate
          createLabel={(value) => t('panels.createValue', { value })}
          emptyLabel={t('panels.noMatches')}
          placeholder={items.length === 0 ? placeholder : undefined}
          inputClassName="sd-chips-input"
          aria-label={placeholder}
          data-testid="list-item-input"
          onPick={onAdd}
          onRemoveLast={items.length > 0 ? () => onRemoveAt(items.length - 1) : undefined}
        />
      ) : (
        <input
          className="sd-chips-input"
          data-testid="list-item-input"
          value={draft}
          aria-label={placeholder}
          placeholder={items.length === 0 ? placeholder : undefined}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Backspace' && draft === '' && items.length > 0) {
              event.preventDefault()
              onRemoveAt(items.length - 1)
            }
          }}
          onBlur={commit}
        />
      )}
    </div>
  )
}
