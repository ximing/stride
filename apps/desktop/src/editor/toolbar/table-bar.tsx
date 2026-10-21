import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { PaintBucket } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  TABLE_CELL_COLORS,
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
  if (!state) return null
  const action = (label: string, command: TableCommand, extra?: { disabled?: boolean; pressed?: boolean }) => {
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
      label="表格操作"
      className="editor-table-bar"
      slots={[
        { id: 'label', measure: { className: 'editor-table-label', text: '表格' }, node: <span className="editor-table-label">表格</span> },
        action('上方加行', 'addRowBefore'),
        action('下方加行', 'addRowAfter'),
        action('删除行', 'deleteRow', { disabled: !state.canDeleteRow }),
        sepSlot('sep-row'),
        action('左侧加列', 'addColumnBefore'),
        action('右侧加列', 'addColumnAfter'),
        action('删除列', 'deleteColumn', { disabled: !state.canDeleteColumn }),
        sepSlot('sep-col'),
        action('合并单元格', 'mergeCells', { disabled: !state.canMerge }),
        action('拆分单元格', 'splitCell', { disabled: !state.canSplit }),
        sepSlot('sep-cell'),
        action('表头行', 'toggleHeaderRow', { pressed: state.headerRow }),
        action('表头列', 'toggleHeaderColumn', { pressed: state.headerColumn }),
        iconSlot('cell-color', (
          <ColorControl
            testId="table-cell-color"
            label="单元格背景"
            clearLabel="无"
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
        action('删除表格', 'deleteTable'),
      ]}
    />
  )
}
