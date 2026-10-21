import { Extension, type Editor } from '@tiptap/core';
import { handleTableShortcut, type TableShortcut } from './table-actions';

/**
 * Inside a table: ⌘↑ / ⌘↓ add a row, ⌘← / ⌘→ add a column.
 * Shift deletes that row or column. Outside a table these keys stay as text navigation.
 */
export const tableKeys = Extension.create({
  name: 'tableKeys',

  addKeyboardShortcuts() {
    const bind = (shortcut: TableShortcut) => () => handleTableShortcut(this.editor as Editor, shortcut);
    return {
      'Mod-ArrowUp': bind('addRowBefore'),
      'Mod-ArrowDown': bind('addRowAfter'),
      'Mod-ArrowLeft': bind('addColumnBefore'),
      'Mod-ArrowRight': bind('addColumnAfter'),
      'Mod-Shift-ArrowUp': bind('deleteRow'),
      'Mod-Shift-ArrowDown': bind('deleteRow'),
      'Mod-Shift-ArrowLeft': bind('deleteColumn'),
      'Mod-Shift-ArrowRight': bind('deleteColumn'),
    };
  },
});
