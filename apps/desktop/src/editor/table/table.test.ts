import { Editor, type JSONContent } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { addTableColumn, addTableRow, deleteTableColumn, deleteTableRow, tableSlashCommand } from './table'

const layoutBox = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 1,
  bottom: 1,
  width: 1,
  height: 1,
  toJSON() {
    return {}
  },
})

if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    const list = [layoutBox()]
    return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList
  }
}
if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return layoutBox() as DOMRect
  }
}

const editors: Editor[] = []

function createEditor(): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  editors.push(editor)
  return editor
}

function grid(doc: JSONContent): string[][] {
  const table = doc.content?.find((node) => node.type === 'table')
  return (table?.content ?? []).map((row) => (row.content ?? []).map((cell) => cell.type ?? ''))
}

function cell(type: 'tableHeader' | 'tableCell', text?: string): JSONContent {
  return {
    type,
    content: [
      text
        ? { type: 'paragraph', content: [{ type: 'text', text }] }
        : { type: 'paragraph' },
    ],
  }
}

function row(type: 'tableHeader' | 'tableCell', texts: Array<string | undefined>): JSONContent {
  return {
    type: 'tableRow',
    content: texts.map((text) => cell(type, text)),
  }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('table', () => {
  it('inserts a 3x3 table with a header row from the slash command', () => {
    expect(tableSlashCommand).toMatchObject({
      id: 'table',
      title: 'Table',
      keywords: 'table 表格',
    })
    const editor = createEditor()
    tableSlashCommand.run(editor)
    expect(grid(editor.getJSON())).toEqual([
      ['tableHeader', 'tableHeader', 'tableHeader'],
      ['tableCell', 'tableCell', 'tableCell'],
      ['tableCell', 'tableCell', 'tableCell'],
    ])
  })

  it('adds and deletes the current row and column', () => {
    const editor = createEditor()
    tableSlashCommand.run(editor)
    expect(addTableRow(editor)).toBe(true)
    expect(grid(editor.getJSON())).toHaveLength(4)
    expect(grid(editor.getJSON())[0]).toEqual(['tableHeader', 'tableHeader', 'tableHeader'])
    expect(deleteTableRow(editor)).toBe(true)
    expect(grid(editor.getJSON())).toHaveLength(3)
    expect(addTableColumn(editor)).toBe(true)
    expect(grid(editor.getJSON()).every((cells) => cells.length === 4)).toBe(true)
    expect(deleteTableColumn(editor)).toBe(true)
    expect(grid(editor.getJSON()).every((cells) => cells.length === 3)).toBe(true)

    const headers = createEditor()
    tableSlashCommand.run(headers)
    expect(addTableColumn(headers)).toBe(true)
    expect(grid(headers.getJSON())[0]).toEqual(['tableHeader', 'tableHeader', 'tableHeader', 'tableHeader'])
    expect(grid(headers.getJSON())[1]).toEqual(['tableCell', 'tableCell', 'tableCell', 'tableCell'])
    expect(deleteTableColumn(headers)).toBe(true)
    expect(grid(headers.getJSON())[0]).toEqual(['tableHeader', 'tableHeader', 'tableHeader'])
  })

  it('round-trips a header cell and a body cell through the note file', () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            row('tableHeader', ['A', undefined, undefined]),
            row('tableCell', ['B', undefined, undefined]),
            row('tableCell', [undefined, undefined, undefined]),
          ],
        },
      ],
    })
    const canonical = editor.getJSON()
    expect(grid(canonical)[0]?.[0]).toBe('tableHeader')
    expect(grid(canonical)[1]?.[0]).toBe('tableCell')
    const parsed = parseNote(serializeNote({
      id: 'table',
      title: 'Table',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'table')
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
  })
})
