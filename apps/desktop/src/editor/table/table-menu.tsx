import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { isInTable } from '@tiptap/pm/tables';
import { Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  TABLE_CELL_COLORS,
  TABLE_COMMAND_KEY,
  applyCellBackground,
  focusClickedTableCell,
  runTableCommand,
  tableActionState,
  tableShortcutLabel,
  type TableCommand,
  type TableShortcut,
} from './table-actions';

type MenuPoint = { x: number; y: number };

type MenuItem = {
  command: TableCommand;
  label: string;
  shortcut?: TableShortcut;
  danger?: boolean;
  pressed?: boolean;
  disabled?: boolean;
};

export function TableContextMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<MenuPoint | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => tableActionState(instance),
  });

  useEffect(() => {
    const dom = editor.view.dom;
    const onContextMenu = (event: MouseEvent) => {
      if (!editor.isEditable || editor.isDestroyed) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('td, th')) return;
      if (!dom.contains(target)) return;
      event.preventDefault();
      focusClickedTableCell(editor.view, event);
      if (!isInTable(editor.state)) return;
      setMenu({ x: event.clientX, y: event.clientY });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      if (!editor.isEditable || !isInTable(editor.state)) return;
      event.preventDefault();
      try {
        const coords = editor.view.coordsAtPos(editor.state.selection.from);
        setMenu({ x: coords.left, y: coords.bottom + 4 });
      } catch {
        setMenu({ x: 16, y: 16 });
      }
    };
    dom.addEventListener('contextmenu', onContextMenu);
    dom.addEventListener('keydown', onKey);
    return () => {
      dom.removeEventListener('contextmenu', onContextMenu);
      dom.removeEventListener('keydown', onKey);
    };
  }, [editor]);

  useEffect(() => {
    if (!menu) return;
    const onTr = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) setMenu(null);
    };
    editor.on('transaction', onTr);
    return () => {
      editor.off('transaction', onTr);
    };
  }, [editor, menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const pointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      editor.commands.focus(undefined, { scrollIntoView: false });
    };
    const scroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [editor, menu]);

  if (!menu) return null;

  const item = (command: TableCommand, extra?: Partial<MenuItem>): MenuItem => ({
    command,
    label: t(TABLE_COMMAND_KEY[command]),
    ...extra,
  });
  const items: Array<MenuItem | 'sep'> = [
    item('addRowBefore', { shortcut: 'addRowBefore' }),
    item('addRowAfter', { shortcut: 'addRowAfter' }),
    item('deleteRow', { shortcut: 'deleteRow', disabled: !state.canDeleteRow }),
    'sep',
    item('addColumnBefore', { shortcut: 'addColumnBefore' }),
    item('addColumnAfter', { shortcut: 'addColumnAfter' }),
    item('deleteColumn', { shortcut: 'deleteColumn', disabled: !state.canDeleteColumn }),
    'sep',
    item('mergeCells', { disabled: !state.canMerge }),
    item('splitCell', { disabled: !state.canSplit }),
    'sep',
    item('toggleHeaderRow', { pressed: state.headerRow }),
    item('toggleHeaderColumn', { pressed: state.headerColumn }),
    'sep',
    item('deleteTable', { danger: true }),
  ];

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  };

  const run = (item: MenuItem) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (item.disabled) return;
    runTableCommand(editor, item.command);
    setMenu(null);
  };

  return createPortal(
    <div
      ref={menuRef}
      className="editor-table-menu"
      role="menu"
      aria-label={t('editor.table.menu')}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={onMenuKey}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === 'sep' ? (
          <div key={`sep-${index}`} className="editor-table-menu-sep" role="separator" />
        ) : (
          <button
            key={item.command}
            type="button"
            role="menuitem"
            className={`editor-table-menu-item${item.danger ? ' is-danger' : ''}${item.pressed ? ' is-on' : ''}`}
            aria-label={item.label}
            aria-pressed={item.pressed}
            disabled={item.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={run(item)}
          >
            <span className="editor-table-menu-label">
              <span className="editor-table-menu-check" aria-hidden="true">
                {item.pressed ? <Check size={14} strokeWidth={1.75} /> : null}
              </span>
              <span>{item.label}</span>
            </span>
            {item.shortcut ? <span className="editor-table-menu-key">{tableShortcutLabel(item.shortcut)}</span> : null}
          </button>
        ),
      )}
      <div className="editor-table-menu-sep" role="separator" />
      <div className="editor-table-menu-colors" role="group" aria-label={t('editor.table.background')}>
        <span>{t('editor.table.backgroundShort')}</span>
        {TABLE_CELL_COLORS.map((color) => (
          <button
            key={color.value}
            type="button"
            className={`editor-color-swatch${state.background === color.value ? ' is-on' : ''}`}
            style={{ background: color.value }}
            aria-label={t(`editor.color.${color.id}`)}
            aria-pressed={state.background === color.value}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              applyCellBackground(editor, color.value);
              setMenu(null);
            }}
          />
        ))}
        <button
          type="button"
          className={`editor-table-menu-clear${state.background ? '' : ' is-on'}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            applyCellBackground(editor, null);
            setMenu(null);
          }}
        >
          {t('common.none')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
