import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  PaintBucket,
  PanelLeft,
  PanelTop,
  Table,
  TableCellsMerge,
  TableCellsSplit,
  TableColumnsSplit,
  TableRowsSplit,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
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
import { Tip } from '../../ui/primitives/tooltip'
import { ColorControl, EditorIcon } from './color-control'
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
  const action = (command: TableCommand, icon: LucideIcon, extra?: { disabled?: boolean; pressed?: boolean }) => {
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
      measure: 'icon',
      node: (
        <Tip content={hint ? `${label}（${hint}）` : label}>
        <button
          type="button"
          className={`editor-tool${extra?.pressed ? ' is-active' : ''}`}
          data-testid={`table-${command}`}
          aria-label={label}
          aria-pressed={extra?.pressed}
          disabled={extra?.disabled}
          onMouseDown={keepSelection}
          onClick={() => runTableCommand(editor, command)}
        >
          <EditorIcon icon={icon} />
        </button>
        </Tip>
      ),
    } satisfies OverflowSlot
  }
  return (
    <OverflowToolbar
      label={t('editor.table.actions')}
      className="editor-table-bar"
      slots={[
        { id: 'label', measure: 'icon', node: <span className="editor-table-label" aria-label={t('editor.table.label')}><EditorIcon icon={Table} /></span> },
        action('addRowBefore', BetweenHorizontalStart),
        action('addRowAfter', BetweenHorizontalEnd),
        action('deleteRow', TableRowsSplit, { disabled: !state.canDeleteRow }),
        sepSlot('sep-row'),
        action('addColumnBefore', BetweenVerticalStart),
        action('addColumnAfter', BetweenVerticalEnd),
        action('deleteColumn', TableColumnsSplit, { disabled: !state.canDeleteColumn }),
        sepSlot('sep-col'),
        action('mergeCells', TableCellsMerge, { disabled: !state.canMerge }),
        action('splitCell', TableCellsSplit, { disabled: !state.canSplit }),
        sepSlot('sep-cell'),
        action('toggleHeaderRow', PanelTop, { pressed: state.headerRow }),
        action('toggleHeaderColumn', PanelLeft, { pressed: state.headerColumn }),
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
        action('deleteTable', Trash2),
      ]}
    />
  )
}
