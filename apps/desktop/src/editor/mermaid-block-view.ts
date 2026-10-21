import type { NodeViewRenderer, NodeViewRendererProps } from '@tiptap/core';
import type { NodeView } from '@tiptap/pm/view';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { mermaidViewOf, type MermaidViewMode } from './mermaid-block';
import { createMermaidFrame } from './mermaid-view';

const MODES: ReadonlyArray<{ id: MermaidViewMode; label: string; hint: string }> = [
  { id: 'code', label: '纯代码', hint: '只显示源码' },
  { id: 'render', label: '渲染', hint: '只显示图形' },
  { id: 'split', label: '混合', hint: '左侧图形，右侧源码' },
];

function readPos(getPos: NodeViewRendererProps['getPos']): number | null {
  if (typeof getPos !== 'function') return null;
  const pos = getPos();
  return typeof pos === 'number' ? pos : null;
}

/**
 * Mermaid block chrome: 纯代码, 渲染, or 混合 (diagram on the left, source on the right).
 * The source stays in the document in every mode. Render mode selects the block
 * so keystrokes do not edit a hidden source.
 */
export const mermaidBlockNodeView: NodeViewRenderer = ({ editor, node, getPos }) => {
  let current = node;

  const wrapper = document.createElement('div');
  wrapper.className = 'doc-mermaid-block';

  const bar = document.createElement('div');
  bar.className = 'doc-mermaid-modes';
  bar.setAttribute('contenteditable', 'false');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Mermaid 显示');

  const buttons = new Map<MermaidViewMode, HTMLButtonElement>();
  for (const mode of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'doc-mermaid-mode';
    button.textContent = mode.label;
    button.setAttribute('aria-label', mode.hint);
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      setMode(mode.id);
    });
    buttons.set(mode.id, button);
    bar.append(button);
  }

  const body = document.createElement('div');
  body.className = 'doc-mermaid-body';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.append(code);

  let sync = (): void => {};
  const frame = createMermaidFrame(() => sync());
  body.append(frame.figure, pre);
  wrapper.append(bar, body);

  const setMode = (next: MermaidViewMode, keepSelection = false): void => {
    if (editor.isDestroyed) return;
    const pos = readPos(getPos);
    if (pos === null) return;
    const block = editor.state.doc.nodeAt(pos);
    if (!block || block.type.name !== 'mermaid') return;
    if (mermaidViewOf(block.attrs.view) === next) return;
    const tr = editor.state.tr.setNodeMarkup(pos, null, { ...block.attrs, view: next });
    if (!keepSelection) {
      const mapped = tr.mapping.map(pos);
      if (next === 'render') {
        tr.setSelection(NodeSelection.create(tr.doc, mapped));
      } else {
        const inside = Math.min(mapped + 1, tr.doc.content.size);
        tr.setSelection(TextSelection.near(tr.doc.resolve(inside)));
      }
    }
    editor.view.dispatch(tr.scrollIntoView());
    if (!keepSelection && next !== 'render' && editor.isEditable) editor.view.focus();
  };

  sync = (): void => {
    const mode = mermaidViewOf(current.attrs.view);
    wrapper.classList.toggle('is-code', mode === 'code');
    wrapper.classList.toggle('is-render', mode === 'render');
    wrapper.classList.toggle('is-split', mode === 'split');
    wrapper.classList.toggle('is-editing', editor.isEditable);
    wrapper.dataset.view = mode;
    pre.hidden = mode === 'render';
    if (mode === 'render') pre.setAttribute('aria-hidden', 'true');
    else pre.removeAttribute('aria-hidden');
    for (const [id, button] of buttons) {
      const on = id === mode;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (mode === 'code') frame.sync('');
    else frame.sync(current.textContent, { debounce: editor.isEditable });
  };

  const onEditor = ({ transaction }: { transaction: { getMeta: (key: string) => unknown } }): void => {
    const ui = transaction.getMeta('uiEvent');
    const pos = readPos(getPos);
    const selection = editor.state.selection;
    const inside =
      pos !== null && selection.from > pos && selection.to < pos + current.nodeSize;
    // Typing into a render-only block would change a hidden source. Show the source beside the diagram.
    if (
      inside &&
      editor.isEditable &&
      mermaidViewOf(current.attrs.view) === 'render' &&
      (ui === 'input' || ui === 'paste' || ui === 'drop')
    ) {
      setMode('split', true);
      return;
    }
    sync();
  };
  editor.on('transaction', onEditor);
  sync();

  // Opening a document can leave the caret in a hidden source. Select the block instead.
  queueMicrotask(() => {
    if (editor.isDestroyed || !editor.isEditable) return;
    const pos = readPos(getPos);
    if (pos === null) return;
    const block = editor.state.doc.nodeAt(pos);
    if (!block || block.type.name !== 'mermaid' || mermaidViewOf(block.attrs.view) !== 'render') return;
    const selection = editor.state.selection;
    const inside = selection.from > pos && selection.to < pos + block.nodeSize;
    if (!inside) return;
    const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos));
    tr.setMeta('addToHistory', false);
    tr.setMeta('preventUpdate', true);
    editor.view.dispatch(tr);
  });

  const view: NodeView = {
    dom: wrapper,
    contentDOM: code,
    update(updated) {
      if (updated.type !== current.type) return false;
      current = updated;
      sync();
      return true;
    },
    stopEvent(event) {
      const target = event.target;
      if (!(target instanceof Element)) return false;
      if (target.closest('.doc-mermaid-modes, .doc-mermaid') !== null) return true;
      return false;
    },
    ignoreMutation(mutation) {
      if (mutation.type === 'selection') return false;
      const target = mutation.target;
      return target !== code && !code.contains(target);
    },
    destroy() {
      frame.destroy();
      editor.off('transaction', onEditor);
    },
  };
  return view;
};
