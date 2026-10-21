import type { Editor } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { DocTableCell, DocTableHeader } from './table-cell'
import { tableKeys } from './table-keys'

export function tableExtensions() {
  return [
    Table.configure({
      resizable: true,
      cellMinWidth: 48,
      handleWidth: 8,
      lastColumnResizable: true,
    }),
    TableRow,
    DocTableHeader,
    DocTableCell,
    tableKeys,
  ]
}

export const tableSlashCommand = {
  id: 'table',
  title: 'Table',
  keywords: 'table 表格',
  run(editor: Editor) {
    editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
  },
}

export function addTableRow(editor: Editor) {
  return editor.commands.addRowAfter()
}

export function deleteTableRow(editor: Editor) {
  return editor.commands.deleteRow()
}

export function addTableColumn(editor: Editor) {
  return editor.commands.addColumnAfter()
}

export function deleteTableColumn(editor: Editor) {
  return editor.commands.deleteColumn()
}
