import { markdownPasteBlocks } from './markdown-paste';
import { Fragment, Slice, type Node } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

type PasteView = {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
  editable?: boolean;
};

type ClipboardReader = {
  getData: (type: string) => string;
};

/**
 * Replace the selection with rich text parsed from clipboard Markdown.
 * Returns false when the caller should keep the editor's default paste.
 * `at` is a drop position; paste uses the current selection.
 */
export function dispatchMarkdownPaste(view: PasteView, clipboard: ClipboardReader, at?: number): boolean {
  if (view.editable === false) return false;
  const tr = markdownPasteTransaction(view.state, readPlain(clipboard), readClip(clipboard, 'text/html'), at);
  if (!tr) return false;
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function markdownPasteTransaction(
  state: EditorState,
  plain: string,
  html = '',
  at?: number,
): Transaction | null {
  const tr = state.tr;
  if (typeof at === 'number') {
    const pos = Math.max(0, Math.min(at, tr.doc.content.size));
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
  }
  if (selectionInCode(tr.selection)) return null;

  const blocks = markdownPasteBlocks(plain, html);
  if (!blocks || blocks.length === 0) return null;

  let nodes: Node[];
  try {
    nodes = blocks.map((block) => state.schema.nodeFromJSON(block));
  } catch {
    return null;
  }
  if (nodes.length === 0) return null;

  try {
    insertBlocks(tr, nodes);
    // A mermaid block in render mode hides its source. Leave the caret after it.
    exitPastedMermaid(tr);
    tr.doc.check();
  } catch {
    return null;
  }
  if (!tr.docChanged) return null;
  return tr;
}

function insertBlocks(tr: Transaction, nodes: Node[]): void {
  const { $from } = tr.selection;
  const emptyHost =
    tr.selection.empty &&
    $from.parent.isTextblock &&
    $from.parent.type.spec.code !== true &&
    $from.parent.content.size === 0;
  const inlineParagraph = nodes.length === 1 && nodes[0]?.type.name === 'paragraph';

  if (emptyHost && !inlineParagraph) {
    tr.replaceWith($from.before(), $from.after(), nodes);
    return;
  }
  tr.replaceSelection(sliceForBlocks(nodes));
}

function sliceForBlocks(nodes: Node[]): Slice {
  const only = nodes[0];
  if (nodes.length === 1 && only?.type.name === 'paragraph') {
    return new Slice(only.content, 0, 0);
  }
  const openEdge = (node: Node | undefined) => (node?.type.name === 'paragraph' ? 1 : 0);
  return new Slice(Fragment.from(nodes), openEdge(nodes[0]), openEdge(nodes[nodes.length - 1]));
}

function exitPastedMermaid(tr: Transaction): void {
  const { $from } = tr.selection;
  let depth = 0;
  for (let level = $from.depth; level > 0; level -= 1) {
    if ($from.node(level).type.name === 'mermaid') {
      depth = level;
      break;
    }
  }
  if (depth === 0) return;

  const after = $from.after(depth);
  const $after = tr.doc.resolve(after);
  const following = $after.nodeAfter;
  if (following?.isTextblock && following.type.spec.code !== true) {
    tr.setSelection(TextSelection.near($after));
    return;
  }

  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (paragraph && $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) {
    tr.insert(after, paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
    return;
  }

  tr.setSelection(NodeSelection.create(tr.doc, $from.before(depth)));
}

function selectionInCode(selection: EditorState['selection']): boolean {
  const points = [selection.$from, selection.$to];
  for (const pos of points) {
    for (let depth = pos.depth; depth > 0; depth -= 1) {
      if (pos.node(depth).type.spec.code) return true;
    }
    if (pos.marks().some((mark) => mark.type.spec.code)) return true;
  }
  return false;
}

function readPlain(clipboard: ClipboardReader): string {
  return (
    readClip(clipboard, 'text/markdown') ||
    readClip(clipboard, 'text/x-markdown') ||
    readClip(clipboard, 'text/plain')
  );
}

function readClip(clipboard: ClipboardReader, type: string): string {
  try {
    return clipboard.getData(type) ?? '';
  } catch {
    return '';
  }
}
