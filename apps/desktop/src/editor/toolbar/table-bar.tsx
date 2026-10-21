import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { PaintBucket } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TABLE_CELL_COLORS,
  TABLE_COMMAND_KEY,
  applyCellBackground,
  runTableCommand,
  tableActionState,
  tableShortcutLabel,
  type TableCommand,
  type TableShortcut,
} from '../table/table-actions'
import { ColorControl } from './color-control'
import { keepSelection } from './state'
import { OverflowToolbar, type OverflowSlot } from './toolbar-overflow'

export function iconSlot(id: string, node: ReactNode, active = false): OverflowSlot {
  return { id, node, active }
}

export function sepSlot(id: string): OverflowSlot {
  return { id, separator: true, node: <span className="editor-tool-sep" /> }
}

export function TableActionBar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => (instance ? tableActionState(instance) : null),
  })
  const [cellColorOpen, setCellColorOpen] = useState(false)
  const { t } = useTranslation()
  if (!state) return null
  const action = (command: TableCommand, extra?: { disabled?: boolean; pressed?: boolean }) => {
    const label = t(TABLE_COMMAND_KEY[command])
    const shortcut: TableShortcut | null =
      command === 'addRowBefore' ||
      command === 'addRowAfter' ||
      command === 'addColumnBefore' ||
      command === 'addColumnAfter' ||
      command === 'deleteRow' ||
      command === 'deleteColumn'
        ? command
        : null
    const hint = shortcut ? tableShortcutLabel(shortcut) : undefined
    return {
      id: command,
      active: extra?.pressed,
      measure: { className: 'editor-tool is-wide', text: label },
      node: (
        <button
          type="button"
          className={`editor-tool is-wide${extra?.pressed ? ' is-active' : ''}`}
          data-testid={`table-${command}`}
          aria-label={label}
          title={hint ? `${label}（${hint}）` : label}
          aria-pressed={extra?.pressed}
          disabled={extra?.disabled}
          onMouseDown={keepSelection}
          onClick={() => runTableCommand(editor, command)}
        >
          {label}
        </button>
      ),
    } satisfies OverflowSlot
  }
  return (
    <OverflowToolbar
      label={t('editor.table.actions')}
      className="editor-table-bar"
      slots={[
        { id: 'label', measure: { className: 'editor-table-label', text: t('editor.table.label') }, node: <span className="editor-table-label">{t('editor.table.label')}</span> },
        action('addRowBefore'),
        action('addRowAfter'),
        action('deleteRow', { disabled: !state.canDeleteRow }),
        sepSlot('sep-row'),
        action('addColumnBefore'),
        action('addColumnAfter'),
        action('deleteColumn', { disabled: !state.canDeleteColumn }),
        sepSlot('sep-col'),
        action('mergeCells', { disabled: !state.canMerge }),
        action('splitCell', { disabled: !state.canSplit }),
        sepSlot('sep-cell'),
        action('toggleHeaderRow', { pressed: state.headerRow }),
        action('toggleHeaderColumn', { pressed: state.headerColumn }),
        iconSlot('cell-color', (
          <ColorControl
            testId="table-cell-color"
            label={t('editor.table.background')}
            clearLabel={t('common.none')}
            icon={PaintBucket}
            value={state.background}
            fallback="#ece7df"
            colors={TABLE_CELL_COLORS}
            open={cellColorOpen}
            pressed={state.background !== ''}
            onOpenChange={setCellColorOpen}
            onPick={(value) => applyCellBackground(editor, value)}
          />
        ), state.background !== ''),
        sepSlot('sep-delete'),
        action('deleteTable'),
      ]}
    />
  )
}
