import { mergeAttributes, Node } from '@tiptap/core';
import { Plugin, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { isMermaidLanguage } from '../code/code-language';

export const MERMAID_VIEWS = ['code', 'render', 'split'] as const;

export type MermaidViewMode = (typeof MERMAID_VIEWS)[number];

const NORMALIZE = 'mermaidNormalize';

/** Stored view, or `render` when the value is missing or unknown. */
export function mermaidViewOf(value: unknown): MermaidViewMode {
  if (value === 'code' || value === 'render' || value === 'split') return value;
  return 'render';
}

/**
 * Turn `codeBlock` nodes whose language is mermaid or mmd into mermaid blocks.
 * A quiet load (history and updates suppressed) always starts in render mode.
 * A user edit keeps split mode when the caret is still inside that block, so
 * typing ```mermaid does not hide the source.
 */
export function replaceMermaidCodeBlocks(
  state: EditorState,
  preferSplitInsideSelection: boolean,
): Transaction | null {
  const mermaid = state.schema.nodes.mermaid;
  const codeBlock = state.schema.nodes.codeBlock;
  if (!mermaid || !codeBlock) return null;

  const codePositions: number[] = [];
  const viewFixes: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type === codeBlock && isMermaidLanguage(node.attrs.language)) codePositions.push(pos);
    if (node.type === mermaid && node.attrs.view !== mermaidViewOf(node.attrs.view)) viewFixes.push(pos);
  });
  if (codePositions.length === 0 && viewFixes.length === 0) return null;

  const tr = state.tr;
  const { from, to } = state.selection;
  for (let index = codePositions.length - 1; index >= 0; index -= 1) {
    const pos = codePositions[index]!;
    const node = tr.doc.nodeAt(pos);
    if (!node || node.type !== codeBlock || !isMermaidLanguage(node.attrs.language)) continue;
    const inside = from > pos && to < pos + node.nodeSize;
    const view: MermaidViewMode = preferSplitInsideSelection && inside ? 'split' : 'render';
    tr.setNodeMarkup(pos, mermaid, { view });
  }
  for (let index = viewFixes.length - 1; index >= 0; index -= 1) {
    const pos = viewFixes[index]!;
    const mapped = tr.mapping.map(pos);
    const node = tr.doc.nodeAt(mapped);
    if (!node || node.type !== mermaid) continue;
    const view = mermaidViewOf(node.attrs.view);
    if (node.attrs.view === view) continue;
    tr.setNodeMarkup(mapped, null, { ...node.attrs, view });
  }
  if (!tr.docChanged) return null;
  tr.setMeta(NORMALIZE, true);
  return tr;
}

function quietTransaction(transactions: readonly Transaction[]): boolean {
  return transactions.every(
    (tr) => tr.getMeta('addToHistory') === false || tr.getMeta('preventUpdate') === true,
  );
}

export const MermaidBlock = Node.create({
  name: 'mermaid',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  addAttributes() {
    return {
      view: {
        default: 'render',
        parseHTML: (element) => mermaidViewOf(element.getAttribute('data-view')),
        renderHTML: (attributes) => ({ 'data-view': mermaidViewOf(attributes.view) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'pre[data-mermaid]', preserveWhitespace: 'full', priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, { 'data-mermaid': '' }), ['code', 0]];
  },

  onCreate() {
    const editor = this.editor;
    queueMicrotask(() => {
      if (editor.isDestroyed) return;
      const tr = replaceMermaidCodeBlocks(editor.state, false);
      if (!tr) return;
      tr.setMeta('addToHistory', false);
      tr.setMeta('preventUpdate', true);
      editor.view.dispatch(tr);
    });
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _old, state) {
          if (transactions.some((tr) => tr.getMeta(NORMALIZE))) return null;
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return replaceMermaidCodeBlocks(state, !quietTransaction(transactions));
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { empty, $anchor } = this.editor.state.selection;
        if (!empty || $anchor.parent.type !== this.type) return false;
        if ($anchor.parent.textContent.length > 0) return false;
        return this.editor.commands.clearNodes();
      },
      Enter: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type !== this.type) return false;
        const isAtEnd = $from.parentOffset === $from.parent.nodeSize - 2;
        if (!isAtEnd || !$from.parent.textContent.endsWith('\n\n')) return false;
        return this.editor
          .chain()
          .command(({ tr }) => {
            tr.delete($from.pos - 2, $from.pos);
            return true;
          })
          .exitCode()
          .run();
      },
      ArrowDown: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type !== this.type) return false;
        if ($from.parentOffset !== $from.parent.nodeSize - 2) return false;
        const after = $from.after();
        const nodeAfter = state.doc.nodeAt(after);
        if (nodeAfter) {
          return this.editor.commands.command(({ tr }) => {
            tr.setSelection(Selection.near(state.doc.resolve(after)));
            return true;
          });
        }
        return this.editor.commands.exitCode();
      },
    };
  },
});
