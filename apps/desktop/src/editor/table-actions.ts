import type { Editor } from '@tiptap/core';
import type { EditorState, Selection } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { CellSelection, cellAround, columnIsHeader, isInTable, rowIsHeader, selectedRect } from '@tiptap/pm/tables';

const CELL_HEX = /^#[0-9a-fA-F]{6}$/;

export const TABLE_CELL_COLORS = [
  { label: '黄', value: '#f6e7a8' },
  { label: '绿', value: '#d7efd4' },
  { label: '蓝', value: '#d6e6f7' },
  { label: '粉', value: '#f8d6d0' },
  { label: '紫', value: '#e7dff6' },
  { label: '灰', value: '#ece7df' },
] as const;

export type TableActionState = {
  headerRow: boolean;
  headerColumn: boolean;
  background: string;
  canMerge: boolean;
  canSplit: boolean;
  canDeleteRow: boolean;
  canDeleteColumn: boolean;
};

export type TableCommand =
  | 'addRowBefore'
  | 'addRowAfter'
  | 'deleteRow'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteColumn'
  | 'mergeCells'
  | 'splitCell'
  | 'toggleHeaderRow'
  | 'toggleHeaderColumn'
  | 'deleteTable';

export type TableShortcut = Extract<
  TableCommand,
  'addRowBefore' | 'addRowAfter' | 'addColumnBefore' | 'addColumnAfter' | 'deleteRow' | 'deleteColumn'
>;

function cellBackgroundOf(editor: Editor): string {
  for (const name of ['tableHeader', 'tableCell'] as const) {
    if (!editor.isActive(name)) continue;
    const value = editor.getAttributes(name).backgroundColor;
    return typeof value === 'string' && CELL_HEX.test(value) ? value.toLowerCase() : '';
  }
  return '';
}

export function tableActionState(editor: Editor): TableActionState {
  const empty: TableActionState = {
    headerRow: false,
    headerColumn: false,
    background: '',
    canMerge: false,
    canSplit: false,
    canDeleteRow: false,
    canDeleteColumn: false,
  };
  if (!isInTable(editor.state)) return empty;
  let headerRow = false;
  let headerColumn = false;
  let canDeleteRow = false;
  let canDeleteColumn = false;
  try {
    const rect = selectedRect(editor.state);
    headerRow = rect.bottom > rect.top;
    for (let row = rect.top; row < rect.bottom; row += 1) {
      if (!rowIsHeader(rect.map, rect.table, row)) headerRow = false;
    }
    headerColumn = rect.right > rect.left;
    for (let col = rect.left; col < rect.right; col += 1) {
      if (!columnIsHeader(rect.map, rect.table, col)) headerColumn = false;
    }
    // prosemirror-tables reports these commands as available even when the
    // selection covers the whole table and the command then refuses to run.
    canDeleteRow = !(rect.top === 0 && rect.bottom === rect.map.height);
    canDeleteColumn = !(rect.left === 0 && rect.right === rect.map.width);
  } catch {
    // The selection is on the table, but not inside a cell.
  }
  return {
    headerRow,
    headerColumn,
    background: cellBackgroundOf(editor),
    canMerge: editor.can().mergeCells(),
    canSplit: editor.can().splitCell(),
    canDeleteRow,
    canDeleteColumn,
  };
}

export function applyCellBackground(editor: Editor, value: string | null): boolean {
  if (!isInTable(editor.state)) return false;
  if (value !== null && !CELL_HEX.test(value)) return false;
  return editor
    .chain()
    .focus(undefined, { scrollIntoView: false })
    .setCellAttribute('backgroundColor', value?.toLowerCase() ?? null)
    .run();
}

export function runTableCommand(editor: Editor, command: TableCommand, focus = true): boolean {
  if (!isInTable(editor.state)) return false;
  const state = tableActionState(editor);
  if (command === 'deleteRow' && !state.canDeleteRow) return false;
  if (command === 'deleteColumn' && !state.canDeleteColumn) return false;
  if (command === 'mergeCells' && !state.canMerge) return false;
  if (command === 'splitCell' && !state.canSplit) return false;
  const chain = focus ? editor.chain().focus(undefined, { scrollIntoView: false }) : editor.chain();
  return chain[command]().run();
}

/** Arrow shortcuts only apply inside a table. A refused delete leaves text selection alone. */
export function handleTableShortcut(editor: Editor, command: TableShortcut): boolean {
  return runTableCommand(editor, command, false);
}

function macKeyboard(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function tableShortcutLabel(command: TableShortcut): string {
  const arrow =
    command === 'addRowBefore' || command === 'deleteRow'
      ? '↑'
      : command === 'addRowAfter'
        ? '↓'
        : command === 'addColumnBefore' || command === 'deleteColumn'
          ? '←'
          : '→';
  const shift = command === 'deleteRow' || command === 'deleteColumn';
  if (macKeyboard()) return shift ? `⌘⇧${arrow}` : `⌘${arrow}`;
  return shift ? `Ctrl+Shift+${arrow}` : `Ctrl+${arrow}`;
}

/**
 * Right-click keeps a cell selection that already covers the clicked cell,
 * so merge still applies. A click in another cell moves the caret there.
 * Returns null when the selection should stay as it is.
 */
export function tableClickSelection(state: EditorState, pos: number): Selection | null {
  const clamped = Math.max(1, Math.min(pos, state.doc.content.size));
  const $pos = state.doc.resolve(clamped);
  const cell = cellAround($pos);
  if (!cell) return null;
  const selection = state.selection;
  if (selection instanceof CellSelection) {
    let hit = false;
    selection.forEachCell((_node, cellPos) => {
      if (cellPos === cell.pos) hit = true;
    });
    if (hit) return null;
  } else {
    const current = cellAround(selection.$from);
    if (current && current.pos === cell.pos) return null;
  }
  const next = TextSelection.near($pos);
  const nextCell = cellAround(next.$from);
  if (!nextCell || nextCell.pos !== cell.pos) return TextSelection.near(state.doc.resolve(cell.pos + 1));
  return next.eq(selection) ? null : next;
}

export function focusClickedTableCell(
  view: EditorView,
  event: { clientX: number; clientY: number; target: EventTarget | null },
): boolean {
  let pos: number | null = null;
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (coords) pos = coords.pos;
  else if (event.target instanceof Element) {
    const cell = event.target.closest('td, th');
    if (cell) {
      try {
        pos = view.posAtDOM(cell, 0);
      } catch {
        pos = null;
      }
    }
  }
  if (pos === null) return isInTable(view.state);
  const next = tableClickSelection(view.state, pos);
  if (!next) return isInTable(view.state);
  view.dispatch(view.state.tr.setSelection(next));
  return true;
}
